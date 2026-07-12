import { serverEnv } from './env';
import { toSafeError } from './safeError';

type ChatProviderId = 'deepseek' | 'moonshot' | 'qwen';

type ChatRole = 'system' | 'user' | 'assistant';

interface ChatProviderConfig {
  id: ChatProviderId;
  name: string;
  baseURL: string;
  apiKey?: string;
  defaultModel: string;
  models: string[];
}

interface ChatCompletionCreateParams {
  model: string;
  messages: Array<{
    role: ChatRole;
    content: string;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  response_format?: unknown;
  signal?: AbortSignal;
}

type StreamingChatCompletionCreateParams = ChatCompletionCreateParams & { stream: true };
type NonStreamingChatCompletionCreateParams = ChatCompletionCreateParams & { stream?: false | undefined };

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content?: string | null;
    };
  }>;
}

interface ChatCompletionChunk {
  choices: Array<{
    delta?: {
      content?: string | null;
    };
  }>;
}

interface EmbeddingCreateParams {
  model: string;
  input: string | string[];
}

interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
  }>;
}

interface CompatibleChatCompletions {
  create(params: StreamingChatCompletionCreateParams): Promise<AsyncIterable<ChatCompletionChunk>>;
  create(params: NonStreamingChatCompletionCreateParams): Promise<ChatCompletionResponse>;
}

interface CompatibleEmbeddings {
  create(params: EmbeddingCreateParams): Promise<EmbeddingResponse>;
}

export class ModelProviderConfigurationError extends Error {
  statusCode = 503;

  constructor(providerName: string, model: string) {
    super(`Model provider ${providerName} is not configured for ${model}`);
    this.name = 'ModelProviderConfigurationError';
  }
}

export class UnsupportedOfficialModelError extends Error {
  statusCode = 400;

  constructor(model: string) {
    super(`Official provider models are not supported by this project: ${model}`);
    this.name = 'UnsupportedOfficialModelError';
  }
}

class CompatibleApiError extends Error {
  statusCode: number;
  responseBody: string;

  constructor(statusCode: number, responseBody: string) {
    super(`Compatible model API request failed with status ${statusCode}`);
    this.name = 'CompatibleApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

const uniqueModels = (models: string[]) => Array.from(new Set(models.filter(Boolean)));

const providerConfigs: ChatProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: serverEnv.DEEPSEEK_BASE_URL,
    apiKey: serverEnv.DEEPSEEK_API_KEY,
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    baseURL: serverEnv.QWEN_BASE_URL,
    apiKey: serverEnv.QWEN_API_KEY,
    defaultModel: serverEnv.QWEN_CHAT_MODEL,
    models: uniqueModels([serverEnv.QWEN_CHAT_MODEL, 'qwen-plus', 'qwen-max', 'qwen-turbo']),
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    baseURL: serverEnv.MOONSHOT_BASE_URL,
    apiKey: serverEnv.MOONSHOT_API_KEY,
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0711-preview'],
  },
];

const providerById = new Map(providerConfigs.map((provider) => [provider.id, provider]));

const findConfiguredProvider = () => providerConfigs.find((provider) => Boolean(provider.apiKey)) || providerConfigs[0];

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const isOfficialModelName = (model: string) => /^(gpt-|o\d)/i.test(model);

class CompatibleLlmClient {
  public readonly baseURL: string;

  private readonly apiKey?: string;

  public readonly chat: { completions: CompatibleChatCompletions };

  public readonly embeddings: CompatibleEmbeddings;

  constructor(apiKey: string | undefined, baseURL: string) {
    this.apiKey = apiKey;
    this.baseURL = trimTrailingSlash(baseURL);
    this.chat = {
      completions: {
        create: this.createChatCompletion.bind(this) as CompatibleChatCompletions['create'],
      },
    };
    this.embeddings = {
      create: this.createEmbedding.bind(this),
    };
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey || ''}`,
      'Content-Type': 'application/json',
    };
  }

  private async postJson<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      throw new CompatibleApiError(response.status, await response.text());
    }

    return response.json() as Promise<T>;
  }

  private async createChatCompletion(params: StreamingChatCompletionCreateParams): Promise<AsyncIterable<ChatCompletionChunk>>;
  private async createChatCompletion(params: NonStreamingChatCompletionCreateParams): Promise<ChatCompletionResponse>;
  private async createChatCompletion(
    params: ChatCompletionCreateParams
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>> {
    if (!params.stream) {
      return this.postJson<ChatCompletionResponse>('/chat/completions', params, params.signal);
    }

    return this.streamChatCompletion(params);
  }

  private async createEmbedding(params: EmbeddingCreateParams) {
    return this.postJson<EmbeddingResponse>('/embeddings', params);
  }

  private async *streamChatCompletion(params: ChatCompletionCreateParams): AsyncIterable<ChatCompletionChunk> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(params),
      signal: params.signal,
    });

    if (!response.ok) {
      throw new CompatibleApiError(response.status, await response.text());
    }

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const pullEvent = () => {
      const lfIndex = buffer.indexOf('\n\n');
      const crlfIndex = buffer.indexOf('\r\n\r\n');
      const indexes = [lfIndex, crlfIndex].filter((index) => index >= 0);
      if (indexes.length === 0) return null;

      const index = Math.min(...indexes);
      const separatorLength = buffer.startsWith('\r\n\r\n', index) ? 4 : 2;
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + separatorLength);
      return event;
    };

    const parseEvent = (event: string) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let event = pullEvent();
      while (event !== null) {
        const data = parseEvent(event);
        if (data === '[DONE]') return;
        if (data) yield JSON.parse(data) as ChatCompletionChunk;
        event = pullEvent();
      }
    }

    buffer += decoder.decode();
    const data = parseEvent(buffer);
    if (data && data !== '[DONE]') {
      yield JSON.parse(data) as ChatCompletionChunk;
    }
  }
}

export const getDefaultChatModel = () => serverEnv.DEFAULT_CHAT_MODEL || findConfiguredProvider().defaultModel;

export const resolveChatModelProvider = (model?: string) => {
  const normalizedModel = (model || '').trim();
  if (normalizedModel && isOfficialModelName(normalizedModel)) {
    throw new UnsupportedOfficialModelError(normalizedModel);
  }

  const exactProvider = providerConfigs.find((provider) => provider.models.includes(normalizedModel));
  if (exactProvider) {
    return {
      provider: exactProvider,
      resolvedModel: normalizedModel,
    };
  }

  if (normalizedModel.startsWith('deepseek-')) {
    const provider = providerById.get('deepseek')!;
    return { provider, resolvedModel: normalizedModel };
  }

  if (normalizedModel.startsWith('qwen-')) {
    const provider = providerById.get('qwen')!;
    return { provider, resolvedModel: normalizedModel };
  }

  if (normalizedModel.startsWith('moonshot-') || normalizedModel.startsWith('kimi-')) {
    const provider = providerById.get('moonshot')!;
    return { provider, resolvedModel: normalizedModel };
  }

  const fallbackProvider = findConfiguredProvider();
  return {
    provider: fallbackProvider,
    resolvedModel: normalizedModel || fallbackProvider.defaultModel,
  };
};

const createCompatibleClient = (provider: ChatProviderConfig) => new CompatibleLlmClient(
  provider.apiKey,
  provider.baseURL
);

export const createChatClientForModel = (model?: string) => {
  const { provider, resolvedModel } = resolveChatModelProvider(model);

  if (!provider.apiKey) {
    throw new ModelProviderConfigurationError(provider.name, resolvedModel);
  }

  return {
    client: createCompatibleClient(provider),
    provider: provider.id,
    resolvedModel,
  };
};

export const getModelProviderHealth = () => {
  const defaultModel = getDefaultChatModel();
  const { provider: defaultProvider } = resolveChatModelProvider(defaultModel);

  return {
    default_provider: defaultProvider.id,
    default_model: defaultModel,
    providers: providerConfigs.map((provider) => {
      const hasKey = Boolean(provider.apiKey);
      return {
        id: provider.id,
        name: provider.name,
        base_url: provider.baseURL,
        default_model: provider.defaultModel,
        models: provider.models,
        'has_api_key': hasKey,
        quota_status: hasKey ? 'unknown' : 'missing_key',
      };
    }),
  };
};

export const chatCompatibleClient = createCompatibleClient(findConfiguredProvider());

const embeddingClient = new CompatibleLlmClient(
  serverEnv.EMBEDDING_API_KEY || serverEnv.QWEN_API_KEY || serverEnv.DEEPSEEK_API_KEY,
  serverEnv.EMBEDDING_BASE_URL
);

const EMBEDDING_MODEL = serverEnv.EMBEDDING_MODEL;

const logEmbeddingDebug = (message: string) => {
  if (serverEnv.EMBEDDING_DEBUG_LOGS) {
    console.info(message);
  }
};

export const getEmbedding = async (text: string) => {
  try {
    logEmbeddingDebug(`[Embedding] Requesting model: ${EMBEDDING_MODEL} from ${embeddingClient.baseURL}`);
    const response = await embeddingClient.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.replace(/\n/g, ' '),
    });
    const vec = response.data[0].embedding;
    logEmbeddingDebug(`[Embedding] Received vector of length: ${vec.length}`);
    return vec;
  } catch (error) {
    console.error('[Embeddings] Request failed:', toSafeError(error));
    throw error;
  }
};

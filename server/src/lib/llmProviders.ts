import { serverEnv } from './env';
import { toSafeError } from './safeError';

type ChatProviderId = 'deepseek' | 'moonshot' | 'qwen';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessageParam {
  role: ChatRole;
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatProviderConfig {
  id: ChatProviderId;
  name: string;
  baseURL: string;
  apiKey?: string;
  defaultModel: string;
  models: string[];
}

export interface ChatCompletionCreateParams {
  model: string;
  messages: ChatMessageParam[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  response_format?: unknown;
  tools?: ChatToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required' | {
    type: 'function';
    function: { name: string };
  };
  signal?: AbortSignal;
}

type StreamingChatCompletionCreateParams = ChatCompletionCreateParams & { stream: true };
type NonStreamingChatCompletionCreateParams = ChatCompletionCreateParams & { stream?: false | undefined };

export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: ChatToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ChatCompletionChunk {
  choices: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        // OpenAI uses a numeric index, but several compatible gateways encode
        // it as a JSON string. Keep the wire type permissive; Agent runtime
        // normalizes and validates the value before merging calls.
        index: number | string;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
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

export interface CompatibleChatCompletions {
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

export class UnsupportedChatModelError extends Error {
  statusCode = 400;

  constructor(model: string) {
    super(`Unsupported chat model: ${model}`);
    this.name = 'UnsupportedChatModelError';
  }
}

export class CompatibleStreamProtocolError extends Error {
  constructor(message = 'Compatible model API stream ended without [DONE]') {
    super(message);
    this.name = 'CompatibleStreamProtocolError';
  }
}

export const assertCompatibleModelStreamComplete = (sawDone: boolean) => {
  if (!sawDone) throw new CompatibleStreamProtocolError();
};

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
const DEFAULT_EXTERNAL_MODEL_TIMEOUT_MS = 120_000;

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
    const requestSignal = signal || AbortSignal.timeout(DEFAULT_EXTERNAL_MODEL_TIMEOUT_MS);
    const response = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: requestSignal,
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
      const { signal, ...payload } = params;
      return this.postJson<ChatCompletionResponse>('/chat/completions', payload, signal);
    }

    return this.streamChatCompletion(params);
  }

  private async createEmbedding(params: EmbeddingCreateParams) {
    return this.postJson<EmbeddingResponse>('/embeddings', params);
  }

  private async *streamChatCompletion(params: ChatCompletionCreateParams): AsyncIterable<ChatCompletionChunk> {
    const { signal, ...payload } = params;
    const requestSignal = signal || AbortSignal.timeout(DEFAULT_EXTERNAL_MODEL_TIMEOUT_MS);
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: requestSignal,
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
    let sawDone = false;

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

    try {
      while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let event = pullEvent();
      while (event !== null) {
        const data = parseEvent(event);
        if (data === '[DONE]') {
          sawDone = true;
          return;
        }
        if (data) yield JSON.parse(data) as ChatCompletionChunk;
        event = pullEvent();
      }
      }

      buffer += decoder.decode();
      const data = parseEvent(buffer);
      if (data === '[DONE]') {
        sawDone = true;
      } else if (data) {
        yield JSON.parse(data) as ChatCompletionChunk;
      }
      // A cleanly closed SSE response without the sentinel is a truncated
      // provider stream. Let callers fail closed instead of persisting a
      // partial answer or executing an incomplete tool call.
      assertCompatibleModelStreamComplete(sawDone);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

export const getDefaultChatModel = () => serverEnv.DEFAULT_CHAT_MODEL || findConfiguredProvider().defaultModel;

const getModelContextWindowTokens = (model: string) => {
  if (model === 'moonshot-v1-8k') return 8_192;
  if (model === 'moonshot-v1-32k') return 32_768;
  if (model === 'moonshot-v1-128k') return 131_072;
  if (model.startsWith('deepseek-')) return 65_536;
  if (model.startsWith('qwen-')) return 131_072;
  if (model.startsWith('kimi-')) return 131_072;
  // Supported model prefixes above cover the public catalog. Keep a
  // conservative fallback for a deployment-specific compatible alias.
  return 32_768;
};

export const getChatModelCapabilities = (model?: string) => {
  const { provider, resolvedModel } = resolveChatModelProvider(model);
  const toolCalling = !(provider.id === 'deepseek' && resolvedModel === 'deepseek-reasoner');
  return {
    provider: provider.id,
    model: resolvedModel,
    tool_calling: toolCalling,
    streaming_tool_calls: toolCalling,
    parallel_tool_calls: toolCalling,
    structured_output: provider.id === 'qwen' || provider.id === 'deepseek',
    context_window_tokens: getModelContextWindowTokens(resolvedModel),
  };
};

export const resolveChatModelProvider = (model?: string) => {
  const normalizedModel = (model || '').trim();
  if (normalizedModel && isOfficialModelName(normalizedModel)) {
    throw new UnsupportedOfficialModelError(normalizedModel);
  }
  if (normalizedModel && !isSupportedChatModelName(normalizedModel)) {
    throw new UnsupportedChatModelError(normalizedModel);
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

export const isSupportedChatModelName = (model: string) => {
  const normalized = model.trim();
  if (!normalized || isOfficialModelName(normalized)) return false;
  if (providerConfigs.some((provider) => provider.models.includes(normalized))) return true;
  return normalized.startsWith('deepseek-')
    || normalized.startsWith('qwen-')
    || normalized.startsWith('moonshot-')
    || normalized.startsWith('kimi-');
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
        capabilities: getChatModelCapabilities(provider.defaultModel),
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

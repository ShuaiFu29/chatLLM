import OpenAI from 'openai';
import { serverEnv } from './env';

type ChatProviderId = 'deepseek' | 'moonshot' | 'qwen' | 'openai';

interface ChatProviderConfig {
  id: ChatProviderId;
  name: string;
  baseURL: string;
  apiKey?: string;
  defaultModel: string;
  models: string[];
}

export class ModelProviderConfigurationError extends Error {
  statusCode = 503;

  constructor(providerName: string, model: string) {
    super(`Model provider ${providerName} is not configured for ${model}`);
    this.name = 'ModelProviderConfigurationError';
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
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKey: serverEnv.OPENAI_API_KEY,
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
  },
];

const providerById = new Map(providerConfigs.map((provider) => [provider.id, provider]));

const findConfiguredProvider = () => providerConfigs.find((provider) => Boolean(provider.apiKey)) || providerConfigs[0];

export const resolveChatModelProvider = (model?: string) => {
  const normalizedModel = (model || '').trim();
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

  if (/^(gpt-|o\d)/.test(normalizedModel)) {
    const provider = providerById.get('openai')!;
    return { provider, resolvedModel: normalizedModel };
  }

  const fallbackProvider = findConfiguredProvider();
  return {
    provider: fallbackProvider,
    resolvedModel: normalizedModel || fallbackProvider.defaultModel,
  };
};

const createOpenAiClient = (provider: ChatProviderConfig) => new OpenAI({
  apiKey: provider.apiKey,
  baseURL: provider.baseURL,
});

export const createChatClientForModel = (model?: string) => {
  const { provider, resolvedModel } = resolveChatModelProvider(model);

  if (!provider.apiKey) {
    throw new ModelProviderConfigurationError(provider.name, resolvedModel);
  }

  return {
    client: createOpenAiClient(provider),
    provider: provider.id,
    resolvedModel,
  };
};

export const getModelProviderHealth = () => {
  const defaultProvider = findConfiguredProvider();

  return {
    default_provider: defaultProvider.id,
    default_model: defaultProvider.defaultModel,
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

export const openai = createOpenAiClient(findConfiguredProvider());

// 2. Embedding Client (OpenAI-compatible / General)
// Note: This is now largely superseded by the Python RAG service,
// but kept here if needed for direct embedding calls in other parts of the app.
// Using configured embedding provider (Qwen/Bailian by default in env)
const embeddingClient = new OpenAI({
  apiKey: serverEnv.EMBEDDING_API_KEY || serverEnv.DEEPSEEK_API_KEY,
  baseURL: serverEnv.EMBEDDING_BASE_URL,
});

// Configured embedding model
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
    console.error(`Embedding Error (Model: ${EMBEDDING_MODEL}):`, error);
    throw error;
  }
};

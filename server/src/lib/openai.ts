import OpenAI from 'openai';
import { serverEnv } from './env';

const chatApiKey = serverEnv.DEEPSEEK_API_KEY || serverEnv.MOONSHOT_API_KEY || serverEnv.OPENAI_API_KEY;

// 1. Chat Client (DeepSeek)
// Using DeepSeek as the primary chat model provider
export const openai = new OpenAI({
  apiKey: chatApiKey,
  baseURL: serverEnv.DEEPSEEK_BASE_URL,
});

// 2. Embedding Client (ZhipuAI / General)
// Note: This is now largely superseded by the Python RAG service,
// but kept here if needed for direct embedding calls in other parts of the app.
// Using configured embedding provider (ZhipuAI by default in env)
const embeddingClient = new OpenAI({
  apiKey: serverEnv.EMBEDDING_API_KEY || serverEnv.DEEPSEEK_API_KEY,
  baseURL: serverEnv.EMBEDDING_BASE_URL,
});

// Configured embedding model
const EMBEDDING_MODEL = serverEnv.EMBEDDING_MODEL;

export const getEmbedding = async (text: string) => {
  try {
    console.log(`[Embedding] Requesting model: ${EMBEDDING_MODEL} from ${embeddingClient.baseURL}`);
    const response = await embeddingClient.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.replace(/\n/g, ' '),
    });
    const vec = response.data[0].embedding;
    console.log(`[Embedding] Received vector of length: ${vec.length}`);
    return vec;
  } catch (error) {
    console.error(`Embedding Error (Model: ${EMBEDDING_MODEL}):`, error);
    throw error;
  }
};

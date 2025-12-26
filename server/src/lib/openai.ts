import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// 1. Chat Client (DeepSeek)
// Using DeepSeek as the primary chat model provider
export const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.MOONSHOT_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
});

// 2. Embedding Client (ZhipuAI / General)
// Note: This is now largely superseded by the Python RAG service,
// but kept here if needed for direct embedding calls in other parts of the app.
// Using configured embedding provider (ZhipuAI by default in env)
const embeddingClient = new OpenAI({
  apiKey: process.env.EMBEDDING_API_KEY || process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.EMBEDDING_BASE_URL || "https://open.bigmodel.cn/api/paas/v4/",
});

// Configured embedding model
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "embedding-2";

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

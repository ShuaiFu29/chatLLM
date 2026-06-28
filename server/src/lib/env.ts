import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const weakJwtSecrets = new Set([
  'super-secret-jwt-key-change-me',
  'change-me',
  'changeme',
  'replace-me',
  'replace-with-a-long-random-secret',
]);

const DEFAULT_SERVER_PORT = 3002;

export interface ServerEnv {
  PORT: number;
  FRONTEND_URL: string;
  BACKEND_URL: string;
  DATABASE_URL: string;
  S3_ENDPOINT: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_FORCE_PATH_STYLE: boolean;
  JWT_SECRET: string;
  RAG_SERVICE_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL: string;
  MOONSHOT_API_KEY?: string;
  OPENAI_API_KEY?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_BASE_URL: string;
  EMBEDDING_MODEL: string;
}

const getRequired = (env: NodeJS.ProcessEnv, key: string) => env[key]?.trim() || '';

const getBoolean = (value: string | undefined, defaultValue: boolean) => {
  if (value === undefined || value.trim() === '') return defaultValue;
  return value.toLowerCase() !== 'false';
};

const getPort = (value: string | undefined) => {
  const parsed = Number.parseInt(value || String(DEFAULT_SERVER_PORT), 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error('Server configuration invalid:\n- PORT must be a positive integer');
  }
  return parsed;
};

export const loadServerEnv = (env: NodeJS.ProcessEnv = process.env): ServerEnv => {
  const requiredKeys = ['DATABASE_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'JWT_SECRET'];
  const missing = requiredKeys.filter((key) => !getRequired(env, key));
  const errors: string[] = [];

  if (missing.length > 0) {
    errors.push(`Missing required server environment variables: ${missing.join(', ')}`);
  }

  const chatKeys = ['DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'OPENAI_API_KEY'];
  if (!chatKeys.some((key) => getRequired(env, key))) {
    errors.push(`At least one chat provider key is required: ${chatKeys.join(', ')}`);
  }

  const jwtSecret = getRequired(env, 'JWT_SECRET');
  if (jwtSecret && (weakJwtSecrets.has(jwtSecret) || jwtSecret.length < 32)) {
    errors.push('JWT_SECRET must be replaced with a long random secret');
  }

  if (errors.length > 0) {
    throw new Error(`Server configuration invalid:\n- ${errors.join('\n- ')}`);
  }

  const port = getPort(env.PORT);

  return {
    PORT: port,
    FRONTEND_URL: env.FRONTEND_URL?.trim() || 'http://localhost:5173',
    BACKEND_URL: env.BACKEND_URL?.trim() || `http://localhost:${port}`,
    DATABASE_URL: getRequired(env, 'DATABASE_URL'),
    S3_ENDPOINT: getRequired(env, 'S3_ENDPOINT'),
    S3_ACCESS_KEY: getRequired(env, 'S3_ACCESS_KEY'),
    S3_SECRET_KEY: getRequired(env, 'S3_SECRET_KEY'),
    S3_BUCKET: env.S3_BUCKET?.trim() || 'documents',
    S3_REGION: env.S3_REGION?.trim() || 'us-east-1',
    S3_FORCE_PATH_STYLE: getBoolean(env.S3_FORCE_PATH_STYLE, true),
    JWT_SECRET: jwtSecret,
    RAG_SERVICE_URL: env.RAG_SERVICE_URL?.trim() || 'http://localhost:8000',
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID?.trim() || undefined,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET?.trim() || undefined,
    HTTP_PROXY: env.HTTP_PROXY?.trim() || undefined,
    HTTPS_PROXY: env.HTTPS_PROXY?.trim() || undefined,
    DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY?.trim() || undefined,
    DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
    MOONSHOT_API_KEY: env.MOONSHOT_API_KEY?.trim() || undefined,
    OPENAI_API_KEY: env.OPENAI_API_KEY?.trim() || undefined,
    EMBEDDING_API_KEY: env.EMBEDDING_API_KEY?.trim() || undefined,
    EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/paas/v4/',
    EMBEDDING_MODEL: env.EMBEDDING_MODEL?.trim() || 'embedding-2',
  };
};

export const serverEnv = loadServerEnv();

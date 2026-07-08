import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const weakJwtSecrets = new Set([
  'super-secret-jwt-key-change-me',
  'change-me',
  'changeme',
  'replace-me',
  'replace-with-a-long-random-secret',
]);

const DEFAULT_SERVER_PORT = 3000;
const DEFAULT_DB_POOL_MAX = 10;
const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_DB_IDLE_TIMEOUT_MS = 30000;
const DEFAULT_DB_QUERY_TIMEOUT_MS = 30000;
const DEFAULT_DB_SLOW_QUERY_THRESHOLD_MS = 500;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60000;
const DEFAULT_RATE_LIMIT_MAX = 600;
const DEFAULT_CHAT_RATE_LIMIT_MAX = 60;
const DEFAULT_UPLOAD_RATE_LIMIT_MAX = 120;
const DEFAULT_RAG_EVAL_RATE_LIMIT_MAX = 30;
const DEFAULT_RAG_EVAL_STALE_RUN_MS = 30 * 60 * 1000;
const DEFAULT_RAG_EVAL_QUEUE_INTERVAL_MS = 5000;
const DEFAULT_RAG_EVAL_QUEUE_CONCURRENCY = 1;
const DEFAULT_RAG_EVAL_QUEUE_MAX_ATTEMPTS = 3;
const DEFAULT_RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS = 60000;
const DEFAULT_RAG_EVAL_QUEUE_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_FILE_QUEUE_INTERVAL_MS = 5000;
const DEFAULT_FILE_QUEUE_CONCURRENCY = 2;
const DEFAULT_FILE_QUEUE_INGEST_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_FILE_QUEUE_INGEST_TIMEOUT_MS = 60 * 1000;
const DEFAULT_FILE_QUEUE_MAX_ATTEMPTS = 3;
const DEFAULT_FILE_QUEUE_RETRY_BASE_DELAY_MS = 60000;
const DEFAULT_FILE_QUEUE_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_RAG_HEALTH_TIMEOUT_MS = 2000;
const DEFAULT_RAG_RETRIEVE_TIMEOUT_MS = 10000;
const DEFAULT_RAG_CLEANUP_TIMEOUT_MS = 10000;
const DEFAULT_RAG_CIRCUIT_FAILURE_THRESHOLD = 5;
const DEFAULT_RAG_CIRCUIT_RESET_MS = 30000;
const DEFAULT_CHAT_STREAM_MAX_CONCURRENT = 20;
const DEFAULT_CHAT_STREAM_MAX_CONCURRENT_PER_USER = 3;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_UPLOAD_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MULTIPART_UPLOAD_PART_SIZE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MULTIPART_UPLOAD_URL_EXPIRES_SECONDS = 15 * 60;
const DEFAULT_MULTIPART_UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

export interface ServerEnv {
  PORT: number;
  FRONTEND_URL: string;
  BACKEND_URL: string;
  CORS_ALLOWED_ORIGINS: string[];
  DATABASE_URL: string;
  S3_ENDPOINT: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_FORCE_PATH_STYLE: boolean;
  JWT_SECRET: string;
  RAG_SERVICE_URL: string;
  RAG_SERVICE_TOKEN?: string;
  METRICS_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL: string;
  MOONSHOT_API_KEY?: string;
  MOONSHOT_BASE_URL: string;
  QWEN_API_KEY?: string;
  QWEN_BASE_URL: string;
  QWEN_CHAT_MODEL: string;
  DEFAULT_CHAT_MODEL: string | null;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_BASE_URL: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DEBUG_LOGS: boolean;
  DB_POOL_MAX: number;
  DB_CONNECTION_TIMEOUT_MS: number;
  DB_IDLE_TIMEOUT_MS: number;
  DB_QUERY_TIMEOUT_MS: number;
  DB_SLOW_QUERY_THRESHOLD_MS: number;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX: number;
  CHAT_RATE_LIMIT_MAX: number;
  UPLOAD_RATE_LIMIT_MAX: number;
  RAG_EVAL_RATE_LIMIT_MAX: number;
  RAG_EVAL_STALE_RUN_MS: number;
  RAG_EVAL_QUEUE_INTERVAL_MS: number;
  RAG_EVAL_QUEUE_CONCURRENCY: number;
  RAG_EVAL_QUEUE_MAX_ATTEMPTS: number;
  RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS: number;
  RAG_EVAL_QUEUE_STALE_AFTER_MS: number;
  FILE_QUEUE_INTERVAL_MS: number;
  FILE_QUEUE_CONCURRENCY: number;
  FILE_QUEUE_INGEST_TIMEOUT_MS: number;
  FILE_QUEUE_MAX_ATTEMPTS: number;
  FILE_QUEUE_RETRY_BASE_DELAY_MS: number;
  FILE_QUEUE_STALE_AFTER_MS: number;
  RAG_HEALTH_TIMEOUT_MS: number;
  RAG_RETRIEVE_TIMEOUT_MS: number;
  RAG_CLEANUP_TIMEOUT_MS: number;
  RAG_CIRCUIT_FAILURE_THRESHOLD: number;
  RAG_CIRCUIT_RESET_MS: number;
  CHAT_STREAM_MAX_CONCURRENT: number;
  CHAT_STREAM_MAX_CONCURRENT_PER_USER: number;
  MAINTENANCE_INTERVAL_MS: number;
  UPLOAD_TEMP_MAX_AGE_MS: number;
  MULTIPART_UPLOAD_PART_SIZE_BYTES: number;
  MULTIPART_UPLOAD_URL_EXPIRES_SECONDS: number;
  MULTIPART_UPLOAD_SESSION_TTL_MS: number;
  SHUTDOWN_TIMEOUT_MS: number;
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

const getPositiveInteger = (
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  errors: string[]
) => {
  const raw = env[key]?.trim();
  if (!raw) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    errors.push(`${key} must be a positive integer`);
    return defaultValue;
  }

  return parsed;
};

const getStringList = (value: string | undefined, defaultValue: string[]) => {
  const rawValues = value?.split(',').map((item) => item.trim()).filter(Boolean);
  const values = rawValues && rawValues.length > 0 ? rawValues : defaultValue;
  return Array.from(new Set(values));
};

const isOfficialProviderModelName = (model: string) => /^(gpt-|o\d)/i.test(model);

export const loadServerEnv = (env: NodeJS.ProcessEnv = process.env): ServerEnv => {
  const requiredKeys = ['DATABASE_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'JWT_SECRET'];
  const missing = requiredKeys.filter((key) => !getRequired(env, key));
  const errors: string[] = [];

  if (missing.length > 0) {
    errors.push(`Missing required server environment variables: ${missing.join(', ')}`);
  }

  if (getRequired(env, 'OPENAI_API_KEY')) {
    errors.push('OPENAI_API_KEY is not supported; use DEEPSEEK_API_KEY, MOONSHOT_API_KEY, or QWEN_API_KEY');
  }

  const chatKeys = ['DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'QWEN_API_KEY'];
  if (!chatKeys.some((key) => getRequired(env, key))) {
    errors.push(`At least one chat provider key is required: ${chatKeys.join(', ')}`);
  }

  const defaultChatModel = env.DEFAULT_CHAT_MODEL?.trim() || '';
  if (defaultChatModel && isOfficialProviderModelName(defaultChatModel)) {
    errors.push('DEFAULT_CHAT_MODEL must use a supported provider model such as deepseek-chat, moonshot-v1-8k, or qwen-plus');
  }

  if (env.NODE_ENV === 'production') {
    if (!getRequired(env, 'RAG_SERVICE_TOKEN')) {
      errors.push('RAG_SERVICE_TOKEN is required in production');
    }
    if (!getRequired(env, 'METRICS_TOKEN')) {
      errors.push('METRICS_TOKEN is required in production');
    }
  }

  const jwtSecret = getRequired(env, 'JWT_SECRET');
  if (jwtSecret && (weakJwtSecrets.has(jwtSecret) || jwtSecret.length < 32)) {
    errors.push('JWT_SECRET must be replaced with a long random secret');
  }

  const dbPoolMax = getPositiveInteger(env, 'DB_POOL_MAX', DEFAULT_DB_POOL_MAX, errors);
  const dbConnectionTimeoutMs = getPositiveInteger(env, 'DB_CONNECTION_TIMEOUT_MS', DEFAULT_DB_CONNECTION_TIMEOUT_MS, errors);
  const dbIdleTimeoutMs = getPositiveInteger(env, 'DB_IDLE_TIMEOUT_MS', DEFAULT_DB_IDLE_TIMEOUT_MS, errors);
  const dbQueryTimeoutMs = getPositiveInteger(env, 'DB_QUERY_TIMEOUT_MS', DEFAULT_DB_QUERY_TIMEOUT_MS, errors);
  const dbSlowQueryThresholdMs = getPositiveInteger(env, 'DB_SLOW_QUERY_THRESHOLD_MS', DEFAULT_DB_SLOW_QUERY_THRESHOLD_MS, errors);
  const rateLimitWindowMs = getPositiveInteger(env, 'RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS, errors);
  const rateLimitMax = getPositiveInteger(env, 'RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX, errors);
  const chatRateLimitMax = getPositiveInteger(env, 'CHAT_RATE_LIMIT_MAX', DEFAULT_CHAT_RATE_LIMIT_MAX, errors);
  const uploadRateLimitMax = getPositiveInteger(env, 'UPLOAD_RATE_LIMIT_MAX', DEFAULT_UPLOAD_RATE_LIMIT_MAX, errors);
  const ragEvalRateLimitMax = getPositiveInteger(env, 'RAG_EVAL_RATE_LIMIT_MAX', DEFAULT_RAG_EVAL_RATE_LIMIT_MAX, errors);
  const ragEvalStaleRunMs = getPositiveInteger(env, 'RAG_EVAL_STALE_RUN_MS', DEFAULT_RAG_EVAL_STALE_RUN_MS, errors);
  const ragEvalQueueIntervalMs = getPositiveInteger(env, 'RAG_EVAL_QUEUE_INTERVAL_MS', DEFAULT_RAG_EVAL_QUEUE_INTERVAL_MS, errors);
  const ragEvalQueueConcurrency = getPositiveInteger(env, 'RAG_EVAL_QUEUE_CONCURRENCY', DEFAULT_RAG_EVAL_QUEUE_CONCURRENCY, errors);
  const ragEvalQueueMaxAttempts = getPositiveInteger(env, 'RAG_EVAL_QUEUE_MAX_ATTEMPTS', DEFAULT_RAG_EVAL_QUEUE_MAX_ATTEMPTS, errors);
  const ragEvalQueueRetryBaseDelayMs = getPositiveInteger(env, 'RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS', DEFAULT_RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS, errors);
  const ragEvalQueueStaleAfterMs = getPositiveInteger(env, 'RAG_EVAL_QUEUE_STALE_AFTER_MS', DEFAULT_RAG_EVAL_QUEUE_STALE_AFTER_MS, errors);
  const fileQueueIntervalMs = getPositiveInteger(env, 'FILE_QUEUE_INTERVAL_MS', DEFAULT_FILE_QUEUE_INTERVAL_MS, errors);
  const fileQueueConcurrency = getPositiveInteger(env, 'FILE_QUEUE_CONCURRENCY', DEFAULT_FILE_QUEUE_CONCURRENCY, errors);
  const fileQueueIngestTimeoutMs = getPositiveInteger(env, 'FILE_QUEUE_INGEST_TIMEOUT_MS', DEFAULT_FILE_QUEUE_INGEST_TIMEOUT_MS, errors);
  const fileQueueMaxAttempts = getPositiveInteger(env, 'FILE_QUEUE_MAX_ATTEMPTS', DEFAULT_FILE_QUEUE_MAX_ATTEMPTS, errors);
  const fileQueueRetryBaseDelayMs = getPositiveInteger(env, 'FILE_QUEUE_RETRY_BASE_DELAY_MS', DEFAULT_FILE_QUEUE_RETRY_BASE_DELAY_MS, errors);
  const fileQueueStaleAfterMs = getPositiveInteger(env, 'FILE_QUEUE_STALE_AFTER_MS', DEFAULT_FILE_QUEUE_STALE_AFTER_MS, errors);
  const ragHealthTimeoutMs = getPositiveInteger(env, 'RAG_HEALTH_TIMEOUT_MS', DEFAULT_RAG_HEALTH_TIMEOUT_MS, errors);
  const ragRetrieveTimeoutMs = getPositiveInteger(env, 'RAG_RETRIEVE_TIMEOUT_MS', DEFAULT_RAG_RETRIEVE_TIMEOUT_MS, errors);
  const ragCleanupTimeoutMs = getPositiveInteger(env, 'RAG_CLEANUP_TIMEOUT_MS', DEFAULT_RAG_CLEANUP_TIMEOUT_MS, errors);
  const ragCircuitFailureThreshold = getPositiveInteger(env, 'RAG_CIRCUIT_FAILURE_THRESHOLD', DEFAULT_RAG_CIRCUIT_FAILURE_THRESHOLD, errors);
  const ragCircuitResetMs = getPositiveInteger(env, 'RAG_CIRCUIT_RESET_MS', DEFAULT_RAG_CIRCUIT_RESET_MS, errors);
  const chatStreamMaxConcurrent = getPositiveInteger(env, 'CHAT_STREAM_MAX_CONCURRENT', DEFAULT_CHAT_STREAM_MAX_CONCURRENT, errors);
  const chatStreamMaxConcurrentPerUser = getPositiveInteger(env, 'CHAT_STREAM_MAX_CONCURRENT_PER_USER', DEFAULT_CHAT_STREAM_MAX_CONCURRENT_PER_USER, errors);
  const maintenanceIntervalMs = getPositiveInteger(env, 'MAINTENANCE_INTERVAL_MS', DEFAULT_MAINTENANCE_INTERVAL_MS, errors);
  const uploadTempMaxAgeMs = getPositiveInteger(env, 'UPLOAD_TEMP_MAX_AGE_MS', DEFAULT_UPLOAD_TEMP_MAX_AGE_MS, errors);
  const multipartUploadPartSizeBytes = getPositiveInteger(env, 'MULTIPART_UPLOAD_PART_SIZE_BYTES', DEFAULT_MULTIPART_UPLOAD_PART_SIZE_BYTES, errors);
  const multipartUploadUrlExpiresSeconds = getPositiveInteger(env, 'MULTIPART_UPLOAD_URL_EXPIRES_SECONDS', DEFAULT_MULTIPART_UPLOAD_URL_EXPIRES_SECONDS, errors);
  const multipartUploadSessionTtlMs = getPositiveInteger(env, 'MULTIPART_UPLOAD_SESSION_TTL_MS', DEFAULT_MULTIPART_UPLOAD_SESSION_TTL_MS, errors);
  const shutdownTimeoutMs = getPositiveInteger(env, 'SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS, errors);

  if (fileQueueIngestTimeoutMs < MIN_FILE_QUEUE_INGEST_TIMEOUT_MS) {
    errors.push(`FILE_QUEUE_INGEST_TIMEOUT_MS must be at least ${MIN_FILE_QUEUE_INGEST_TIMEOUT_MS}`);
  }

  if (errors.length > 0) {
    throw new Error(`Server configuration invalid:\n- ${errors.join('\n- ')}`);
  }

  const port = getPort(env.PORT);

  const frontendUrl = env.FRONTEND_URL?.trim() || 'http://localhost:5173';

  return {
    PORT: port,
    FRONTEND_URL: frontendUrl,
    BACKEND_URL: env.BACKEND_URL?.trim() || `http://localhost:${port}`,
    CORS_ALLOWED_ORIGINS: getStringList(env.CORS_ALLOWED_ORIGINS, [frontendUrl, 'http://localhost:5174']),
    DATABASE_URL: getRequired(env, 'DATABASE_URL'),
    S3_ENDPOINT: getRequired(env, 'S3_ENDPOINT'),
    S3_ACCESS_KEY: getRequired(env, 'S3_ACCESS_KEY'),
    S3_SECRET_KEY: getRequired(env, 'S3_SECRET_KEY'),
    S3_BUCKET: env.S3_BUCKET?.trim() || 'documents',
    S3_REGION: env.S3_REGION?.trim() || 'us-east-1',
    S3_FORCE_PATH_STYLE: getBoolean(env.S3_FORCE_PATH_STYLE, true),
    JWT_SECRET: jwtSecret,
    RAG_SERVICE_URL: env.RAG_SERVICE_URL?.trim() || 'http://localhost:8000',
    RAG_SERVICE_TOKEN: env.RAG_SERVICE_TOKEN?.trim() || undefined,
    METRICS_TOKEN: env.METRICS_TOKEN?.trim() || undefined,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID?.trim() || undefined,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET?.trim() || undefined,
    HTTP_PROXY: env.HTTP_PROXY?.trim() || undefined,
    HTTPS_PROXY: env.HTTPS_PROXY?.trim() || undefined,
    DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY?.trim() || undefined,
    DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
    MOONSHOT_API_KEY: env.MOONSHOT_API_KEY?.trim() || undefined,
    MOONSHOT_BASE_URL: env.MOONSHOT_BASE_URL?.trim() || 'https://api.moonshot.cn/v1',
    QWEN_API_KEY: env.QWEN_API_KEY?.trim() || undefined,
    QWEN_BASE_URL: env.QWEN_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    QWEN_CHAT_MODEL: env.QWEN_CHAT_MODEL?.trim() || 'qwen-plus',
    DEFAULT_CHAT_MODEL: env.DEFAULT_CHAT_MODEL?.trim() || null,
    EMBEDDING_API_KEY: env.EMBEDDING_API_KEY?.trim() || undefined,
    EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL?.trim() || 'https://llm-ro9cl3th56gnvkzo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    EMBEDDING_MODEL: env.EMBEDDING_MODEL?.trim() || 'text-embedding-v4',
    EMBEDDING_DEBUG_LOGS: getBoolean(env.EMBEDDING_DEBUG_LOGS, false),
    DB_POOL_MAX: dbPoolMax,
    DB_CONNECTION_TIMEOUT_MS: dbConnectionTimeoutMs,
    DB_IDLE_TIMEOUT_MS: dbIdleTimeoutMs,
    DB_QUERY_TIMEOUT_MS: dbQueryTimeoutMs,
    DB_SLOW_QUERY_THRESHOLD_MS: dbSlowQueryThresholdMs,
    RATE_LIMIT_WINDOW_MS: rateLimitWindowMs,
    RATE_LIMIT_MAX: rateLimitMax,
    CHAT_RATE_LIMIT_MAX: chatRateLimitMax,
    UPLOAD_RATE_LIMIT_MAX: uploadRateLimitMax,
    RAG_EVAL_RATE_LIMIT_MAX: ragEvalRateLimitMax,
    RAG_EVAL_STALE_RUN_MS: ragEvalStaleRunMs,
    RAG_EVAL_QUEUE_INTERVAL_MS: ragEvalQueueIntervalMs,
    RAG_EVAL_QUEUE_CONCURRENCY: ragEvalQueueConcurrency,
    RAG_EVAL_QUEUE_MAX_ATTEMPTS: ragEvalQueueMaxAttempts,
    RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS: ragEvalQueueRetryBaseDelayMs,
    RAG_EVAL_QUEUE_STALE_AFTER_MS: ragEvalQueueStaleAfterMs,
    FILE_QUEUE_INTERVAL_MS: fileQueueIntervalMs,
    FILE_QUEUE_CONCURRENCY: fileQueueConcurrency,
    FILE_QUEUE_INGEST_TIMEOUT_MS: fileQueueIngestTimeoutMs,
    FILE_QUEUE_MAX_ATTEMPTS: fileQueueMaxAttempts,
    FILE_QUEUE_RETRY_BASE_DELAY_MS: fileQueueRetryBaseDelayMs,
    FILE_QUEUE_STALE_AFTER_MS: fileQueueStaleAfterMs,
    RAG_HEALTH_TIMEOUT_MS: ragHealthTimeoutMs,
    RAG_RETRIEVE_TIMEOUT_MS: ragRetrieveTimeoutMs,
    RAG_CLEANUP_TIMEOUT_MS: ragCleanupTimeoutMs,
    RAG_CIRCUIT_FAILURE_THRESHOLD: ragCircuitFailureThreshold,
    RAG_CIRCUIT_RESET_MS: ragCircuitResetMs,
    CHAT_STREAM_MAX_CONCURRENT: chatStreamMaxConcurrent,
    CHAT_STREAM_MAX_CONCURRENT_PER_USER: chatStreamMaxConcurrentPerUser,
    MAINTENANCE_INTERVAL_MS: maintenanceIntervalMs,
    UPLOAD_TEMP_MAX_AGE_MS: uploadTempMaxAgeMs,
    MULTIPART_UPLOAD_PART_SIZE_BYTES: multipartUploadPartSizeBytes,
    MULTIPART_UPLOAD_URL_EXPIRES_SECONDS: multipartUploadUrlExpiresSeconds,
    MULTIPART_UPLOAD_SESSION_TTL_MS: multipartUploadSessionTtlMs,
    SHUTDOWN_TIMEOUT_MS: shutdownTimeoutMs,
  };
};

export const serverEnv = loadServerEnv();

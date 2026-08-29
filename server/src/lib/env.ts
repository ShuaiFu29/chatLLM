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
const DEFAULT_TRUST_PROXY_HOPS = 0;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60000;
const DEFAULT_RATE_LIMIT_MAX = 600;
const DEFAULT_CHAT_RATE_LIMIT_MAX = 60;
const DEFAULT_UPLOAD_RATE_LIMIT_MAX = 120;
const DEFAULT_RAG_EVAL_RATE_LIMIT_MAX = 30;
const DEFAULT_RAG_EVAL_STALE_RUN_MS = 30 * 60 * 1000;
const DEFAULT_AGENT_RUN_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_AGENT_MEMORY_EMBEDDING_QUEUE_INTERVAL_MS = 5_000;
const DEFAULT_AGENT_MEMORY_EMBEDDING_QUEUE_CONCURRENCY = 2;
const DEFAULT_AGENT_MEMORY_EMBEDDING_TIMEOUT_MS = 10_000;
const DEFAULT_AGENT_MEMORY_EMBEDDING_LEASE_MS = 30_000;
const DEFAULT_AGENT_MEMORY_EMBEDDING_MAX_ATTEMPTS = 5;
const DEFAULT_AGENT_MEMORY_EMBEDDING_RETRY_BASE_DELAY_MS = 5_000;
const DEFAULT_RAG_EVAL_QUEUE_INTERVAL_MS = 5000;
const DEFAULT_RAG_EVAL_QUEUE_CONCURRENCY = 1;
const DEFAULT_RAG_EVAL_QUEUE_MAX_ATTEMPTS = 3;
const DEFAULT_RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS = 60000;
const DEFAULT_RAG_EVAL_QUEUE_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_RAG_EVAL_CASE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_RAG_EVAL_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RAG_EVAL_MAX_CASES_PER_DATASET = 500;
const DEFAULT_RAG_EVAL_MAX_CASES_PER_RUN = 500;
const MAX_RAG_EVAL_CASE_LIMIT = 5000;
const MIN_RAG_EVAL_QUEUE_STALE_AFTER_MS = 4000;
const MAX_RAG_EVAL_TIMEOUT_MS = 2147483647;
const DEFAULT_FILE_QUEUE_INTERVAL_MS = 5000;
const DEFAULT_FILE_QUEUE_CONCURRENCY = 2;
const DEFAULT_FILE_QUEUE_INGEST_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_FILE_QUEUE_INGEST_TIMEOUT_MS = 60 * 1000;
const DEFAULT_FILE_QUEUE_MAX_ATTEMPTS = 3;
const DEFAULT_FILE_QUEUE_RETRY_BASE_DELAY_MS = 60000;
const DEFAULT_FILE_QUEUE_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_RAG_HEALTH_TIMEOUT_MS = 10000;
const DEFAULT_RAG_RETRIEVE_TIMEOUT_MS = 30000;
const DEFAULT_RAG_RETRIEVE_MAX_ATTEMPTS = 2;
const DEFAULT_RAG_RETRIEVE_TOTAL_TIMEOUT_MS = 60000;
const DEFAULT_RAG_RETRIEVE_RETRY_DELAY_MS = 250;
const DEFAULT_RAG_CLEANUP_TIMEOUT_MS = 10000;
const DEFAULT_RAG_CIRCUIT_FAILURE_THRESHOLD = 5;
const DEFAULT_RAG_CIRCUIT_RESET_MS = 30000;
const DEFAULT_CHAT_STREAM_MAX_CONCURRENT = 20;
const DEFAULT_CHAT_STREAM_MAX_CONCURRENT_PER_USER = 3;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_UPLOAD_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_USER_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_MAX_USER_ACTIVE_UPLOAD_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MULTIPART_UPLOAD_PART_SIZE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MULTIPART_UPLOAD_URL_EXPIRES_SECONDS = 15 * 60;
const DEFAULT_MULTIPART_UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MULTIPART_COMPLETION_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_AGENT_HTTP_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_AGENT_MAX_AGENTS_PER_USER = 100;
const DEFAULT_AGENT_MAX_TOOLS_PER_USER = 100;
const DEFAULT_AGENT_MAX_VERSIONS_PER_AGENT = 100;
const DEFAULT_AGENT_MAX_ACTIVE_RUNS_PER_USER = 3;
const DEFAULT_AGENT_MAX_SOURCES = 50;
const DEFAULT_AGENT_MAX_SOURCE_BYTES = 512 * 1024;
const DEFAULT_AGENT_MAX_TOKEN_BUDGET = 100_000;
const DEFAULT_AGENT_MAX_STEP_PAYLOAD_BYTES = 256 * 1024;
// Only transport-level tool failures are retried, and only while the Run's own
// deadline still allows it. Two attempts turns a single dropped connection from a
// lost Run into a hiccup without meaningfully widening the duplicate-effect window.
const DEFAULT_AGENT_TOOL_MAX_ATTEMPTS = 2;
// Tokens withheld for a final, tool-free turn so an exhausted Run can still
// answer partially instead of failing with nothing to show.
const DEFAULT_AGENT_FINAL_ANSWER_RESERVE_TOKENS = 1_500;
const DEFAULT_AGENT_MAX_TOOL_CALLS_PER_RUN = 40;
// How many subagents one dispatch may start. Bounds provider concurrency and the
// worst-case cost of a single model decision.
const DEFAULT_AGENT_MAX_SUBAGENT_FANOUT = 3;
// Nesting depth for a Run tree. The database enforces the same ceiling, so a
// runtime bug cannot exceed it.
const DEFAULT_AGENT_MAX_SUBAGENT_DEPTH = 3;
// Lease held while a dispatched subagent executes. Renewed while it works; a lease
// that lapses means the holder died and the subtask is failed rather than retried.
const DEFAULT_AGENT_SUBAGENT_LEASE_MS = 2 * 60 * 1000;
// How long a subagent waits for a human to decide an approval it bubbled up. Also
// bounded by the tree's own deadline, so it can never outlive the run.
const DEFAULT_AGENT_SUBAGENT_APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;

export interface ServerEnv {
  PORT: number;
  FRONTEND_URL: string;
  BACKEND_URL: string;
  CORS_ALLOWED_ORIGINS: string[];
  DATABASE_URL: string;
  REDIS_URL: string;
  REDIS_KEY_PREFIX: string;
  S3_ENDPOINT: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_FORCE_PATH_STYLE: boolean;
  JWT_SECRET: string;
  RAG_SERVICE_URL: string;
  RAG_SERVICE_TOKEN: string;
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
  TRUST_PROXY_HOPS: number;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX: number;
  CHAT_RATE_LIMIT_MAX: number;
  UPLOAD_RATE_LIMIT_MAX: number;
  RAG_EVAL_RATE_LIMIT_MAX: number;
  RAG_EVAL_STALE_RUN_MS: number;
  AGENT_RUN_STALE_AFTER_MS: number;
  AGENT_MEMORY_EMBEDDING_QUEUE_INTERVAL_MS: number;
  AGENT_MEMORY_EMBEDDING_QUEUE_CONCURRENCY: number;
  AGENT_MEMORY_EMBEDDING_TIMEOUT_MS: number;
  AGENT_MEMORY_EMBEDDING_LEASE_MS: number;
  AGENT_MEMORY_EMBEDDING_MAX_ATTEMPTS: number;
  AGENT_MEMORY_EMBEDDING_RETRY_BASE_DELAY_MS: number;
  RAG_EVAL_QUEUE_INTERVAL_MS: number;
  RAG_EVAL_QUEUE_CONCURRENCY: number;
  RAG_EVAL_QUEUE_MAX_ATTEMPTS: number;
  RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS: number;
  RAG_EVAL_QUEUE_STALE_AFTER_MS: number;
  RAG_EVAL_CASE_TIMEOUT_MS: number;
  RAG_EVAL_RUN_TIMEOUT_MS: number;
  RAG_EVAL_MAX_CASES_PER_DATASET: number;
  RAG_EVAL_MAX_CASES_PER_RUN: number;
  FILE_QUEUE_INTERVAL_MS: number;
  FILE_QUEUE_CONCURRENCY: number;
  FILE_QUEUE_INGEST_TIMEOUT_MS: number;
  FILE_QUEUE_MAX_ATTEMPTS: number;
  FILE_QUEUE_RETRY_BASE_DELAY_MS: number;
  FILE_QUEUE_STALE_AFTER_MS: number;
  RAG_HEALTH_TIMEOUT_MS: number;
  RAG_RETRIEVE_TIMEOUT_MS: number;
  RAG_RETRIEVE_MAX_ATTEMPTS: number;
  RAG_RETRIEVE_TOTAL_TIMEOUT_MS: number;
  RAG_RETRIEVE_RETRY_DELAY_MS: number;
  RAG_CLEANUP_TIMEOUT_MS: number;
  RAG_CIRCUIT_FAILURE_THRESHOLD: number;
  RAG_CIRCUIT_RESET_MS: number;
  CHAT_STREAM_MAX_CONCURRENT: number;
  CHAT_STREAM_MAX_CONCURRENT_PER_USER: number;
  MAINTENANCE_INTERVAL_MS: number;
  UPLOAD_TEMP_MAX_AGE_MS: number;
  MAX_DOCUMENT_BYTES: number;
  MAX_USER_STORAGE_BYTES: number;
  MAX_USER_ACTIVE_UPLOAD_BYTES: number;
  MULTIPART_UPLOAD_PART_SIZE_BYTES: number;
  MULTIPART_UPLOAD_URL_EXPIRES_SECONDS: number;
  MULTIPART_UPLOAD_SESSION_TTL_MS: number;
  MULTIPART_COMPLETION_LEASE_MS: number;
  SHUTDOWN_TIMEOUT_MS: number;
  AGENT_TOOL_ENCRYPTION_KEY?: string;
  AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID?: string;
  AGENT_TOOL_ENCRYPTION_KEYS: Record<string, string>;
  AGENT_HTTP_ALLOWED_HOSTS: string[];
  AGENT_MCP_ALLOWED_HOSTS: string[];
  AGENT_HTTP_MAX_RESPONSE_BYTES: number;
  AGENT_MAX_AGENTS_PER_USER: number;
  AGENT_MAX_TOOLS_PER_USER: number;
  AGENT_MAX_VERSIONS_PER_AGENT: number;
  AGENT_MAX_ACTIVE_RUNS_PER_USER: number;
  AGENT_MAX_SOURCES: number;
  AGENT_MAX_SOURCE_BYTES: number;
  AGENT_MAX_TOKEN_BUDGET: number;
  AGENT_MAX_STEP_PAYLOAD_BYTES: number;
  AGENT_TOOL_MAX_ATTEMPTS: number;
  AGENT_FINAL_ANSWER_RESERVE_TOKENS: number;
  AGENT_MAX_TOOL_CALLS_PER_RUN: number;
  AGENT_MAX_SUBAGENT_FANOUT: number;
  AGENT_MAX_SUBAGENT_DEPTH: number;
  AGENT_SUBAGENT_LEASE_MS: number;
  AGENT_SUBAGENT_APPROVAL_TIMEOUT_MS: number;
}

const getRequired = (env: NodeJS.ProcessEnv, key: string) => env[key]?.trim() || '';

const AGENT_TOOL_KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_TOOL_KEY_HEX = /^[a-fA-F0-9]{64}$/;

const getAgentToolEncryptionKeys = (
  env: NodeJS.ProcessEnv,
  errors: string[],
): Record<string, string> => {
  const raw = getRequired(env, 'AGENT_TOOL_ENCRYPTION_KEYS');
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push('AGENT_TOOL_ENCRYPTION_KEYS must be a JSON object of key IDs to 64-character hexadecimal keys');
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('AGENT_TOOL_ENCRYPTION_KEYS must be a JSON object');
    return {};
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 32) {
    errors.push('AGENT_TOOL_ENCRYPTION_KEYS may contain at most 32 keys');
  }
  const keys: Record<string, string> = {};
  for (const [keyId, value] of entries.slice(0, 32)) {
    if (!AGENT_TOOL_KEY_ID.test(keyId)) {
      errors.push(`Invalid AGENT_TOOL_ENCRYPTION_KEYS key ID: ${keyId}`);
      continue;
    }
    if (typeof value !== 'string' || !AGENT_TOOL_KEY_HEX.test(value)) {
      errors.push(`AGENT_TOOL_ENCRYPTION_KEYS.${keyId} must be a 64-character hexadecimal value`);
      continue;
    }
    keys[keyId] = value;
  }
  return keys;
};

const TRUE_BOOLEAN_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Parse a boolean flag strictly.
 *
 * The old rule was "anything that is not literally `false` is true", so the very
 * natural `S3_FORCE_PATH_STYLE=0` silently enabled path style, and a typo like
 * `flase` did too. Accept the usual spellings of both sides and report anything
 * else as a configuration error instead of guessing.
 */
const getBoolean = (
  value: string | undefined,
  defaultValue: boolean,
  key?: string,
  errors?: string[],
) => {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (TRUE_BOOLEAN_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_VALUES.has(normalized)) return false;
  if (key && errors) {
    errors.push(`${key} must be one of true/false, 1/0, yes/no, on/off`);
  }
  return defaultValue;
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

const getNonNegativeSafeInteger = (
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  errors: string[]
) => {
  const raw = env[key]?.trim();
  if (!raw) return defaultValue;

  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    errors.push(`${key} must be a non-negative safe integer`);
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    errors.push(`${key} must be a non-negative safe integer`);
    return defaultValue;
  }

  return parsed;
};

const getPositiveSafeInteger = (
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  errors: string[]
) => {
  const raw = env[key]?.trim();
  if (!raw) return defaultValue;

  if (!/^[1-9]\d*$/.test(raw)) {
    errors.push(`${key} must be a positive safe integer`);
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    errors.push(`${key} must be a positive safe integer`);
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
  const requiredKeys = ['DATABASE_URL', 'REDIS_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'JWT_SECRET'];
  const missing = requiredKeys.filter((key) => !getRequired(env, key));
  const errors: string[] = [];

  if (missing.length > 0) {
    errors.push(`Missing required server environment variables: ${missing.join(', ')}`);
  }

  const ragServiceToken = getRequired(env, 'RAG_SERVICE_TOKEN');
  if (!ragServiceToken) {
    errors.push('RAG_SERVICE_TOKEN is required');
  } else if (ragServiceToken.length < 32) {
    errors.push('RAG_SERVICE_TOKEN must be at least 32 characters');
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
  const configuredQwenModel = env.QWEN_CHAT_MODEL?.trim() || 'qwen-plus';
  if (
    defaultChatModel
    && !['deepseek-chat', 'deepseek-reasoner', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0711-preview'].includes(defaultChatModel)
    && defaultChatModel !== configuredQwenModel
    && !/^(deepseek-|qwen-|moonshot-|kimi-)/i.test(defaultChatModel)
    && !isOfficialProviderModelName(defaultChatModel)
  ) {
    errors.push('DEFAULT_CHAT_MODEL must use a recognized DeepSeek, Qwen, Moonshot, or Kimi model name');
  }

  if (env.NODE_ENV === 'production') {
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
  const trustProxyHops = getNonNegativeSafeInteger(env, 'TRUST_PROXY_HOPS', DEFAULT_TRUST_PROXY_HOPS, errors);
  const rateLimitWindowMs = getPositiveInteger(env, 'RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS, errors);
  const rateLimitMax = getPositiveInteger(env, 'RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX, errors);
  const chatRateLimitMax = getPositiveInteger(env, 'CHAT_RATE_LIMIT_MAX', DEFAULT_CHAT_RATE_LIMIT_MAX, errors);
  const uploadRateLimitMax = getPositiveInteger(env, 'UPLOAD_RATE_LIMIT_MAX', DEFAULT_UPLOAD_RATE_LIMIT_MAX, errors);
  const ragEvalRateLimitMax = getPositiveInteger(env, 'RAG_EVAL_RATE_LIMIT_MAX', DEFAULT_RAG_EVAL_RATE_LIMIT_MAX, errors);
  const ragEvalStaleRunMs = getPositiveInteger(env, 'RAG_EVAL_STALE_RUN_MS', DEFAULT_RAG_EVAL_STALE_RUN_MS, errors);
  const agentRunStaleAfterMs = getPositiveInteger(env, 'AGENT_RUN_STALE_AFTER_MS', DEFAULT_AGENT_RUN_STALE_AFTER_MS, errors);
  const agentMemoryEmbeddingQueueIntervalMs = getPositiveInteger(
    env,
    'AGENT_MEMORY_EMBEDDING_QUEUE_INTERVAL_MS',
    DEFAULT_AGENT_MEMORY_EMBEDDING_QUEUE_INTERVAL_MS,
    errors,
  );
  const agentMemoryEmbeddingQueueConcurrency = getPositiveInteger(
    env,
    'AGENT_MEMORY_EMBEDDING_QUEUE_CONCURRENCY',
    DEFAULT_AGENT_MEMORY_EMBEDDING_QUEUE_CONCURRENCY,
    errors,
  );
  const agentMemoryEmbeddingTimeoutMs = getPositiveInteger(
    env,
    'AGENT_MEMORY_EMBEDDING_TIMEOUT_MS',
    DEFAULT_AGENT_MEMORY_EMBEDDING_TIMEOUT_MS,
    errors,
  );
  const agentMemoryEmbeddingLeaseMs = getPositiveInteger(
    env,
    'AGENT_MEMORY_EMBEDDING_LEASE_MS',
    DEFAULT_AGENT_MEMORY_EMBEDDING_LEASE_MS,
    errors,
  );
  const agentMemoryEmbeddingMaxAttempts = getPositiveInteger(
    env,
    'AGENT_MEMORY_EMBEDDING_MAX_ATTEMPTS',
    DEFAULT_AGENT_MEMORY_EMBEDDING_MAX_ATTEMPTS,
    errors,
  );
  const agentMemoryEmbeddingRetryBaseDelayMs = getPositiveInteger(
    env,
    'AGENT_MEMORY_EMBEDDING_RETRY_BASE_DELAY_MS',
    DEFAULT_AGENT_MEMORY_EMBEDDING_RETRY_BASE_DELAY_MS,
    errors,
  );
  if (agentMemoryEmbeddingLeaseMs < agentMemoryEmbeddingTimeoutMs + 1_000) {
    errors.push('AGENT_MEMORY_EMBEDDING_LEASE_MS must exceed AGENT_MEMORY_EMBEDDING_TIMEOUT_MS by at least 1000ms');
  }
  if (agentMemoryEmbeddingMaxAttempts > 100) {
    errors.push('AGENT_MEMORY_EMBEDDING_MAX_ATTEMPTS must be at most 100');
  }
  const ragEvalQueueIntervalMs = getPositiveInteger(env, 'RAG_EVAL_QUEUE_INTERVAL_MS', DEFAULT_RAG_EVAL_QUEUE_INTERVAL_MS, errors);
  const ragEvalQueueConcurrency = getPositiveInteger(env, 'RAG_EVAL_QUEUE_CONCURRENCY', DEFAULT_RAG_EVAL_QUEUE_CONCURRENCY, errors);
  const ragEvalQueueMaxAttempts = getPositiveInteger(env, 'RAG_EVAL_QUEUE_MAX_ATTEMPTS', DEFAULT_RAG_EVAL_QUEUE_MAX_ATTEMPTS, errors);
  const ragEvalQueueRetryBaseDelayMs = getPositiveInteger(env, 'RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS', DEFAULT_RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS, errors);
  const ragEvalQueueStaleAfterMs = getPositiveInteger(env, 'RAG_EVAL_QUEUE_STALE_AFTER_MS', DEFAULT_RAG_EVAL_QUEUE_STALE_AFTER_MS, errors);
  const ragEvalCaseTimeoutMs = getPositiveInteger(env, 'RAG_EVAL_CASE_TIMEOUT_MS', DEFAULT_RAG_EVAL_CASE_TIMEOUT_MS, errors);
  const ragEvalRunTimeoutMs = getPositiveInteger(env, 'RAG_EVAL_RUN_TIMEOUT_MS', DEFAULT_RAG_EVAL_RUN_TIMEOUT_MS, errors);
  const ragEvalMaxCasesPerDataset = getPositiveInteger(
    env, 'RAG_EVAL_MAX_CASES_PER_DATASET', DEFAULT_RAG_EVAL_MAX_CASES_PER_DATASET, errors
  );
  const ragEvalMaxCasesPerRun = getPositiveInteger(
    env, 'RAG_EVAL_MAX_CASES_PER_RUN', DEFAULT_RAG_EVAL_MAX_CASES_PER_RUN, errors
  );
  if (ragEvalQueueStaleAfterMs < MIN_RAG_EVAL_QUEUE_STALE_AFTER_MS) {
    errors.push(`RAG_EVAL_QUEUE_STALE_AFTER_MS must be at least ${MIN_RAG_EVAL_QUEUE_STALE_AFTER_MS}`);
  }
  if (ragEvalQueueStaleAfterMs > MAX_RAG_EVAL_TIMEOUT_MS) {
    errors.push(`RAG_EVAL_QUEUE_STALE_AFTER_MS must be at most ${MAX_RAG_EVAL_TIMEOUT_MS}`);
  }
  if (ragEvalCaseTimeoutMs > MAX_RAG_EVAL_TIMEOUT_MS) {
    errors.push(`RAG_EVAL_CASE_TIMEOUT_MS must be at most ${MAX_RAG_EVAL_TIMEOUT_MS}`);
  }
  if (ragEvalRunTimeoutMs > MAX_RAG_EVAL_TIMEOUT_MS) {
    errors.push(`RAG_EVAL_RUN_TIMEOUT_MS must be at most ${MAX_RAG_EVAL_TIMEOUT_MS}`);
  }
  if (ragEvalRunTimeoutMs < ragEvalCaseTimeoutMs) {
    errors.push('RAG_EVAL_RUN_TIMEOUT_MS must be at least RAG_EVAL_CASE_TIMEOUT_MS');
  }
  if (ragEvalMaxCasesPerDataset > MAX_RAG_EVAL_CASE_LIMIT) {
    errors.push(`RAG_EVAL_MAX_CASES_PER_DATASET must be at most ${MAX_RAG_EVAL_CASE_LIMIT}`);
  }
  if (ragEvalMaxCasesPerRun > ragEvalMaxCasesPerDataset) {
    errors.push('RAG_EVAL_MAX_CASES_PER_RUN must not exceed RAG_EVAL_MAX_CASES_PER_DATASET');
  }
  const fileQueueIntervalMs = getPositiveInteger(env, 'FILE_QUEUE_INTERVAL_MS', DEFAULT_FILE_QUEUE_INTERVAL_MS, errors);
  const fileQueueConcurrency = getPositiveInteger(env, 'FILE_QUEUE_CONCURRENCY', DEFAULT_FILE_QUEUE_CONCURRENCY, errors);
  const fileQueueIngestTimeoutMs = getPositiveInteger(env, 'FILE_QUEUE_INGEST_TIMEOUT_MS', DEFAULT_FILE_QUEUE_INGEST_TIMEOUT_MS, errors);
  const fileQueueMaxAttempts = getPositiveInteger(env, 'FILE_QUEUE_MAX_ATTEMPTS', DEFAULT_FILE_QUEUE_MAX_ATTEMPTS, errors);
  const fileQueueRetryBaseDelayMs = getPositiveInteger(env, 'FILE_QUEUE_RETRY_BASE_DELAY_MS', DEFAULT_FILE_QUEUE_RETRY_BASE_DELAY_MS, errors);
  const fileQueueStaleAfterMs = getPositiveInteger(env, 'FILE_QUEUE_STALE_AFTER_MS', DEFAULT_FILE_QUEUE_STALE_AFTER_MS, errors);
  const ragHealthTimeoutMs = getPositiveInteger(env, 'RAG_HEALTH_TIMEOUT_MS', DEFAULT_RAG_HEALTH_TIMEOUT_MS, errors);
  const ragRetrieveTimeoutMs = getPositiveInteger(env, 'RAG_RETRIEVE_TIMEOUT_MS', DEFAULT_RAG_RETRIEVE_TIMEOUT_MS, errors);
  const ragRetrieveMaxAttempts = getPositiveInteger(env, 'RAG_RETRIEVE_MAX_ATTEMPTS', DEFAULT_RAG_RETRIEVE_MAX_ATTEMPTS, errors);
  const ragRetrieveTotalTimeoutMs = getPositiveInteger(env, 'RAG_RETRIEVE_TOTAL_TIMEOUT_MS', DEFAULT_RAG_RETRIEVE_TOTAL_TIMEOUT_MS, errors);
  const ragRetrieveRetryDelayMs = getPositiveInteger(env, 'RAG_RETRIEVE_RETRY_DELAY_MS', DEFAULT_RAG_RETRIEVE_RETRY_DELAY_MS, errors);
  const ragCleanupTimeoutMs = getPositiveInteger(env, 'RAG_CLEANUP_TIMEOUT_MS', DEFAULT_RAG_CLEANUP_TIMEOUT_MS, errors);
  const ragCircuitFailureThreshold = getPositiveInteger(env, 'RAG_CIRCUIT_FAILURE_THRESHOLD', DEFAULT_RAG_CIRCUIT_FAILURE_THRESHOLD, errors);
  const ragCircuitResetMs = getPositiveInteger(env, 'RAG_CIRCUIT_RESET_MS', DEFAULT_RAG_CIRCUIT_RESET_MS, errors);
  const chatStreamMaxConcurrent = getPositiveInteger(env, 'CHAT_STREAM_MAX_CONCURRENT', DEFAULT_CHAT_STREAM_MAX_CONCURRENT, errors);
  const chatStreamMaxConcurrentPerUser = getPositiveInteger(env, 'CHAT_STREAM_MAX_CONCURRENT_PER_USER', DEFAULT_CHAT_STREAM_MAX_CONCURRENT_PER_USER, errors);
  const maintenanceIntervalMs = getPositiveInteger(env, 'MAINTENANCE_INTERVAL_MS', DEFAULT_MAINTENANCE_INTERVAL_MS, errors);
  const uploadTempMaxAgeMs = getPositiveInteger(env, 'UPLOAD_TEMP_MAX_AGE_MS', DEFAULT_UPLOAD_TEMP_MAX_AGE_MS, errors);
  const maxDocumentBytes = getPositiveSafeInteger(env, 'MAX_DOCUMENT_BYTES', DEFAULT_MAX_DOCUMENT_BYTES, errors);
  const maxUserStorageBytes = getPositiveSafeInteger(env, 'MAX_USER_STORAGE_BYTES', DEFAULT_MAX_USER_STORAGE_BYTES, errors);
  const maxUserActiveUploadBytes = getPositiveSafeInteger(
    env,
    'MAX_USER_ACTIVE_UPLOAD_BYTES',
    DEFAULT_MAX_USER_ACTIVE_UPLOAD_BYTES,
    errors
  );
  const multipartUploadPartSizeBytes = getPositiveInteger(env, 'MULTIPART_UPLOAD_PART_SIZE_BYTES', DEFAULT_MULTIPART_UPLOAD_PART_SIZE_BYTES, errors);
  const multipartUploadUrlExpiresSeconds = getPositiveInteger(env, 'MULTIPART_UPLOAD_URL_EXPIRES_SECONDS', DEFAULT_MULTIPART_UPLOAD_URL_EXPIRES_SECONDS, errors);
  const multipartUploadSessionTtlMs = getPositiveInteger(env, 'MULTIPART_UPLOAD_SESSION_TTL_MS', DEFAULT_MULTIPART_UPLOAD_SESSION_TTL_MS, errors);
  const multipartCompletionLeaseMs = getPositiveInteger(env, 'MULTIPART_COMPLETION_LEASE_MS', DEFAULT_MULTIPART_COMPLETION_LEASE_MS, errors);
  const shutdownTimeoutMs = getPositiveInteger(env, 'SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS, errors);
  const agentHttpMaxResponseBytes = getPositiveSafeInteger(
    env,
    'AGENT_HTTP_MAX_RESPONSE_BYTES',
    DEFAULT_AGENT_HTTP_MAX_RESPONSE_BYTES,
    errors,
  );
  const agentMaxAgentsPerUser = getPositiveInteger(
    env, 'AGENT_MAX_AGENTS_PER_USER', DEFAULT_AGENT_MAX_AGENTS_PER_USER, errors,
  );
  const agentMaxToolsPerUser = getPositiveInteger(
    env, 'AGENT_MAX_TOOLS_PER_USER', DEFAULT_AGENT_MAX_TOOLS_PER_USER, errors,
  );
  const agentMaxVersionsPerAgent = getPositiveInteger(
    env, 'AGENT_MAX_VERSIONS_PER_AGENT', DEFAULT_AGENT_MAX_VERSIONS_PER_AGENT, errors,
  );
  const agentMaxActiveRunsPerUser = getPositiveInteger(
    env, 'AGENT_MAX_ACTIVE_RUNS_PER_USER', DEFAULT_AGENT_MAX_ACTIVE_RUNS_PER_USER, errors,
  );
  const agentMaxSources = getPositiveInteger(env, 'AGENT_MAX_SOURCES', DEFAULT_AGENT_MAX_SOURCES, errors);
  const agentMaxSourceBytes = getPositiveSafeInteger(
    env, 'AGENT_MAX_SOURCE_BYTES', DEFAULT_AGENT_MAX_SOURCE_BYTES, errors,
  );
  const agentMaxTokenBudget = getPositiveSafeInteger(
    env, 'AGENT_MAX_TOKEN_BUDGET', DEFAULT_AGENT_MAX_TOKEN_BUDGET, errors,
  );
  const agentMaxStepPayloadBytes = getPositiveSafeInteger(
    env, 'AGENT_MAX_STEP_PAYLOAD_BYTES', DEFAULT_AGENT_MAX_STEP_PAYLOAD_BYTES, errors,
  );
  const agentToolMaxAttempts = getPositiveInteger(
    env, 'AGENT_TOOL_MAX_ATTEMPTS', DEFAULT_AGENT_TOOL_MAX_ATTEMPTS, errors,
  );
  const agentFinalAnswerReserveTokens = getPositiveInteger(
    env, 'AGENT_FINAL_ANSWER_RESERVE_TOKENS', DEFAULT_AGENT_FINAL_ANSWER_RESERVE_TOKENS, errors,
  );
  const agentMaxToolCallsPerRun = getPositiveInteger(
    env, 'AGENT_MAX_TOOL_CALLS_PER_RUN', DEFAULT_AGENT_MAX_TOOL_CALLS_PER_RUN, errors,
  );
  const agentMaxSubagentFanout = getPositiveInteger(
    env, 'AGENT_MAX_SUBAGENT_FANOUT', DEFAULT_AGENT_MAX_SUBAGENT_FANOUT, errors,
  );
  const agentMaxSubagentDepth = getPositiveInteger(
    env, 'AGENT_MAX_SUBAGENT_DEPTH', DEFAULT_AGENT_MAX_SUBAGENT_DEPTH, errors,
  );
  const agentSubagentLeaseMs = getPositiveInteger(
    env, 'AGENT_SUBAGENT_LEASE_MS', DEFAULT_AGENT_SUBAGENT_LEASE_MS, errors,
  );
  const agentSubagentApprovalTimeoutMs = getPositiveInteger(
    env,
    'AGENT_SUBAGENT_APPROVAL_TIMEOUT_MS',
    DEFAULT_AGENT_SUBAGENT_APPROVAL_TIMEOUT_MS,
    errors,
  );
  // The schema caps depth at 3; allowing a larger runtime value would only turn a
  // configuration mistake into a constraint violation mid-run.
  if (agentMaxSubagentDepth > 3) {
    errors.push('AGENT_MAX_SUBAGENT_DEPTH must be at most 3');
  }
  // The reserve is carved out of the token budget, so it cannot swallow it.
  if (agentFinalAnswerReserveTokens >= agentMaxTokenBudget) {
    errors.push(
      'AGENT_FINAL_ANSWER_RESERVE_TOKENS must be smaller than AGENT_MAX_TOKEN_BUDGET',
    );
  }
  const agentToolEncryptionKey = getRequired(env, 'AGENT_TOOL_ENCRYPTION_KEY');
  if (agentToolEncryptionKey && !AGENT_TOOL_KEY_HEX.test(agentToolEncryptionKey)) {
    errors.push('AGENT_TOOL_ENCRYPTION_KEY must be a 64-character hexadecimal value');
  }
  const agentToolEncryptionKeys = getAgentToolEncryptionKeys(env, errors);
  const agentToolEncryptionActiveKeyId = getRequired(
    env,
    'AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID',
  );
  if (
    agentToolEncryptionActiveKeyId
    && !AGENT_TOOL_KEY_ID.test(agentToolEncryptionActiveKeyId)
  ) {
    errors.push('AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID must contain only letters, numbers, underscores, or hyphens');
  }
  if (Object.keys(agentToolEncryptionKeys).length > 0 && !agentToolEncryptionActiveKeyId) {
    errors.push('AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID is required when AGENT_TOOL_ENCRYPTION_KEYS is configured');
  }
  if (
    agentToolEncryptionActiveKeyId
    && !agentToolEncryptionKeys[agentToolEncryptionActiveKeyId]
    && !agentToolEncryptionKey
  ) {
    errors.push('AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID must select a configured encryption key');
  }

  if (fileQueueIngestTimeoutMs < MIN_FILE_QUEUE_INGEST_TIMEOUT_MS) {
    errors.push(`FILE_QUEUE_INGEST_TIMEOUT_MS must be at least ${MIN_FILE_QUEUE_INGEST_TIMEOUT_MS}`);
  }

  if (ragRetrieveTotalTimeoutMs < ragRetrieveTimeoutMs) {
    errors.push('RAG_RETRIEVE_TOTAL_TIMEOUT_MS must be at least RAG_RETRIEVE_TIMEOUT_MS');
  }

  // Parse boolean flags before the error gate so an unrecognized value fails
  // startup instead of silently resolving to its default.
  const s3ForcePathStyle = getBoolean(env.S3_FORCE_PATH_STYLE, true, 'S3_FORCE_PATH_STYLE', errors);
  const embeddingDebugLogs = getBoolean(env.EMBEDDING_DEBUG_LOGS, false, 'EMBEDDING_DEBUG_LOGS', errors);

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
    REDIS_URL: getRequired(env, 'REDIS_URL'),
    REDIS_KEY_PREFIX: env.REDIS_KEY_PREFIX?.trim() || 'chatllm',
    S3_ENDPOINT: getRequired(env, 'S3_ENDPOINT'),
    S3_ACCESS_KEY: getRequired(env, 'S3_ACCESS_KEY'),
    S3_SECRET_KEY: getRequired(env, 'S3_SECRET_KEY'),
    S3_BUCKET: env.S3_BUCKET?.trim() || 'documents',
    S3_REGION: env.S3_REGION?.trim() || 'us-east-1',
    S3_FORCE_PATH_STYLE: s3ForcePathStyle,
    JWT_SECRET: jwtSecret,
    RAG_SERVICE_URL: env.RAG_SERVICE_URL?.trim() || 'http://localhost:8000',
    RAG_SERVICE_TOKEN: ragServiceToken,
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
    EMBEDDING_DEBUG_LOGS: embeddingDebugLogs,
    DB_POOL_MAX: dbPoolMax,
    DB_CONNECTION_TIMEOUT_MS: dbConnectionTimeoutMs,
    DB_IDLE_TIMEOUT_MS: dbIdleTimeoutMs,
    DB_QUERY_TIMEOUT_MS: dbQueryTimeoutMs,
    DB_SLOW_QUERY_THRESHOLD_MS: dbSlowQueryThresholdMs,
    TRUST_PROXY_HOPS: trustProxyHops,
    RATE_LIMIT_WINDOW_MS: rateLimitWindowMs,
    RATE_LIMIT_MAX: rateLimitMax,
    CHAT_RATE_LIMIT_MAX: chatRateLimitMax,
    UPLOAD_RATE_LIMIT_MAX: uploadRateLimitMax,
    RAG_EVAL_RATE_LIMIT_MAX: ragEvalRateLimitMax,
    RAG_EVAL_STALE_RUN_MS: ragEvalStaleRunMs,
    AGENT_RUN_STALE_AFTER_MS: agentRunStaleAfterMs,
    AGENT_MEMORY_EMBEDDING_QUEUE_INTERVAL_MS: agentMemoryEmbeddingQueueIntervalMs,
    AGENT_MEMORY_EMBEDDING_QUEUE_CONCURRENCY: agentMemoryEmbeddingQueueConcurrency,
    AGENT_MEMORY_EMBEDDING_TIMEOUT_MS: agentMemoryEmbeddingTimeoutMs,
    AGENT_MEMORY_EMBEDDING_LEASE_MS: agentMemoryEmbeddingLeaseMs,
    AGENT_MEMORY_EMBEDDING_MAX_ATTEMPTS: agentMemoryEmbeddingMaxAttempts,
    AGENT_MEMORY_EMBEDDING_RETRY_BASE_DELAY_MS: agentMemoryEmbeddingRetryBaseDelayMs,
    RAG_EVAL_QUEUE_INTERVAL_MS: ragEvalQueueIntervalMs,
    RAG_EVAL_QUEUE_CONCURRENCY: ragEvalQueueConcurrency,
    RAG_EVAL_QUEUE_MAX_ATTEMPTS: ragEvalQueueMaxAttempts,
    RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS: ragEvalQueueRetryBaseDelayMs,
    RAG_EVAL_QUEUE_STALE_AFTER_MS: ragEvalQueueStaleAfterMs,
    RAG_EVAL_CASE_TIMEOUT_MS: ragEvalCaseTimeoutMs,
    RAG_EVAL_RUN_TIMEOUT_MS: ragEvalRunTimeoutMs,
    RAG_EVAL_MAX_CASES_PER_DATASET: ragEvalMaxCasesPerDataset,
    RAG_EVAL_MAX_CASES_PER_RUN: ragEvalMaxCasesPerRun,
    FILE_QUEUE_INTERVAL_MS: fileQueueIntervalMs,
    FILE_QUEUE_CONCURRENCY: fileQueueConcurrency,
    FILE_QUEUE_INGEST_TIMEOUT_MS: fileQueueIngestTimeoutMs,
    FILE_QUEUE_MAX_ATTEMPTS: fileQueueMaxAttempts,
    FILE_QUEUE_RETRY_BASE_DELAY_MS: fileQueueRetryBaseDelayMs,
    FILE_QUEUE_STALE_AFTER_MS: fileQueueStaleAfterMs,
    RAG_HEALTH_TIMEOUT_MS: ragHealthTimeoutMs,
    RAG_RETRIEVE_TIMEOUT_MS: ragRetrieveTimeoutMs,
    RAG_RETRIEVE_MAX_ATTEMPTS: ragRetrieveMaxAttempts,
    RAG_RETRIEVE_TOTAL_TIMEOUT_MS: ragRetrieveTotalTimeoutMs,
    RAG_RETRIEVE_RETRY_DELAY_MS: ragRetrieveRetryDelayMs,
    RAG_CLEANUP_TIMEOUT_MS: ragCleanupTimeoutMs,
    RAG_CIRCUIT_FAILURE_THRESHOLD: ragCircuitFailureThreshold,
    RAG_CIRCUIT_RESET_MS: ragCircuitResetMs,
    CHAT_STREAM_MAX_CONCURRENT: chatStreamMaxConcurrent,
    CHAT_STREAM_MAX_CONCURRENT_PER_USER: chatStreamMaxConcurrentPerUser,
    MAINTENANCE_INTERVAL_MS: maintenanceIntervalMs,
    UPLOAD_TEMP_MAX_AGE_MS: uploadTempMaxAgeMs,
    MAX_DOCUMENT_BYTES: maxDocumentBytes,
    MAX_USER_STORAGE_BYTES: maxUserStorageBytes,
    MAX_USER_ACTIVE_UPLOAD_BYTES: maxUserActiveUploadBytes,
    MULTIPART_UPLOAD_PART_SIZE_BYTES: multipartUploadPartSizeBytes,
    MULTIPART_UPLOAD_URL_EXPIRES_SECONDS: multipartUploadUrlExpiresSeconds,
    MULTIPART_UPLOAD_SESSION_TTL_MS: multipartUploadSessionTtlMs,
    MULTIPART_COMPLETION_LEASE_MS: multipartCompletionLeaseMs,
    SHUTDOWN_TIMEOUT_MS: shutdownTimeoutMs,
    AGENT_TOOL_ENCRYPTION_KEY: agentToolEncryptionKey || undefined,
    AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID: agentToolEncryptionActiveKeyId || undefined,
    AGENT_TOOL_ENCRYPTION_KEYS: agentToolEncryptionKeys,
    AGENT_HTTP_ALLOWED_HOSTS: getStringList(env.AGENT_HTTP_ALLOWED_HOSTS, []),
    AGENT_MCP_ALLOWED_HOSTS: getStringList(env.AGENT_MCP_ALLOWED_HOSTS, []),
    AGENT_HTTP_MAX_RESPONSE_BYTES: agentHttpMaxResponseBytes,
    AGENT_MAX_AGENTS_PER_USER: agentMaxAgentsPerUser,
    AGENT_MAX_TOOLS_PER_USER: agentMaxToolsPerUser,
    AGENT_MAX_VERSIONS_PER_AGENT: agentMaxVersionsPerAgent,
    AGENT_MAX_ACTIVE_RUNS_PER_USER: agentMaxActiveRunsPerUser,
    AGENT_MAX_SOURCES: agentMaxSources,
    AGENT_MAX_SOURCE_BYTES: agentMaxSourceBytes,
    AGENT_MAX_TOKEN_BUDGET: agentMaxTokenBudget,
    AGENT_MAX_STEP_PAYLOAD_BYTES: agentMaxStepPayloadBytes,
    AGENT_TOOL_MAX_ATTEMPTS: agentToolMaxAttempts,
    AGENT_FINAL_ANSWER_RESERVE_TOKENS: agentFinalAnswerReserveTokens,
    AGENT_MAX_TOOL_CALLS_PER_RUN: agentMaxToolCallsPerRun,
    AGENT_MAX_SUBAGENT_FANOUT: agentMaxSubagentFanout,
    AGENT_MAX_SUBAGENT_DEPTH: agentMaxSubagentDepth,
    AGENT_SUBAGENT_LEASE_MS: agentSubagentLeaseMs,
    AGENT_SUBAGENT_APPROVAL_TIMEOUT_MS: agentSubagentApprovalTimeoutMs,
  };
};

export const serverEnv = loadServerEnv();

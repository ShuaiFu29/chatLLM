import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const envModulePath = path.join(serverRoot, 'dist', 'lib', 'env.js');

const baseEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  ComSpec: process.env.ComSpec,
  PATHEXT: process.env.PATHEXT,
  NODE_ENV: 'test',
};

function importServerEnv(overrides, expression = 'serverEnv.DATABASE_URL') {
  return spawnSync(
    process.execPath,
    ['-e', `const { serverEnv } = require(${JSON.stringify(envModulePath)}); console.log(JSON.stringify(${expression}));`],
    {
      cwd: serverRoot,
      env: { ...baseEnv, ...overrides },
      encoding: 'utf8',
    }
  );
}

function parseLastJsonLine(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

test('server env fails fast when required keys are missing', () => {
  const result = importServerEnv({
    DATABASE_URL: '',
    S3_ENDPOINT: '',
    S3_ACCESS_KEY: '',
    S3_SECRET_KEY: '',
    JWT_SECRET: '',
    DEEPSEEK_API_KEY: '',
    MOONSHOT_API_KEY: '',
    OPENAI_API_KEY: '',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required server environment variables: DATABASE_URL, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, JWT_SECRET/);
  assert.match(result.stderr, /At least one chat provider key is required: DEEPSEEK_API_KEY, MOONSHOT_API_KEY, OPENAI_API_KEY/);
});

test('server env rejects weak JWT placeholder secrets', () => {
  const result = importServerEnv({
    PORT: '',
    BACKEND_URL: '',
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'super-secret-jwt-key-change-me',
    DEEPSEEK_API_KEY: 'sk-test',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET must be replaced with a long random secret/);
});

test('server env loads valid required values', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /postgres:\/\/chatllm:chatllm@localhost:5432\/chatllm/);
});

test('server env defaults to port 3000 and matching backend URL', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  }, '({ PORT: serverEnv.PORT, BACKEND_URL: serverEnv.BACKEND_URL })');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseLastJsonLine(result.stdout), {
    PORT: 3000,
    BACKEND_URL: 'http://localhost:3000',
  });
});

test('server env derives default backend URL from explicit port', () => {
  const result = importServerEnv({
    PORT: '3015',
    BACKEND_URL: '',
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  }, 'serverEnv.BACKEND_URL');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseLastJsonLine(result.stdout), 'http://localhost:3015');
});

test('server env defaults embedding debug logs off and parses explicit opt-in', () => {
  const defaultResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  }, 'serverEnv.EMBEDDING_DEBUG_LOGS');

  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(parseLastJsonLine(defaultResult.stdout), false);

  const enabledResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    EMBEDDING_DEBUG_LOGS: 'true',
  }, 'serverEnv.EMBEDDING_DEBUG_LOGS');

  assert.equal(enabledResult.status, 0, enabledResult.stderr);
  assert.equal(parseLastJsonLine(enabledResult.stdout), true);
});

test('server env parses comma-separated CORS allowed origins', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    FRONTEND_URL: 'http://localhost:5173',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173, https://chat.example.com, http://localhost:5174',
  }, 'serverEnv.CORS_ALLOWED_ORIGINS');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseLastJsonLine(result.stdout), [
    'http://localhost:5173',
    'https://chat.example.com',
    'http://localhost:5174',
  ]);
});

test('server env exposes configurable RAG ingest timeout for file queue jobs', () => {
  const defaultResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  }, 'serverEnv.FILE_QUEUE_INGEST_TIMEOUT_MS');

  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(parseLastJsonLine(defaultResult.stdout), 10000);

  const explicitResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    FILE_QUEUE_INGEST_TIMEOUT_MS: '45000',
  }, 'serverEnv.FILE_QUEUE_INGEST_TIMEOUT_MS');

  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.equal(parseLastJsonLine(explicitResult.stdout), 45000);
});

test('server env exposes configurable RAG cleanup timeout for destructive cleanup calls', () => {
  const defaultResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  }, 'serverEnv.RAG_CLEANUP_TIMEOUT_MS');

  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(parseLastJsonLine(defaultResult.stdout), 10000);

  const explicitResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    RAG_CLEANUP_TIMEOUT_MS: '30000',
  }, 'serverEnv.RAG_CLEANUP_TIMEOUT_MS');

  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.equal(parseLastJsonLine(explicitResult.stdout), 30000);
});

test('server env exposes configurable RAG evaluation route rate limit', () => {
  const defaultResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  }, 'serverEnv.RAG_EVAL_RATE_LIMIT_MAX');

  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(parseLastJsonLine(defaultResult.stdout), 30);

  const explicitResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    RAG_EVAL_RATE_LIMIT_MAX: '12',
  }, 'serverEnv.RAG_EVAL_RATE_LIMIT_MAX');

  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.equal(parseLastJsonLine(explicitResult.stdout), 12);
});

test('server env exposes configurable stale RAG evaluation run timeout', () => {
  const defaultResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  }, 'serverEnv.RAG_EVAL_STALE_RUN_MS');

  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(parseLastJsonLine(defaultResult.stdout), 30 * 60 * 1000);

  const explicitResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    RAG_EVAL_STALE_RUN_MS: '900000',
  }, 'serverEnv.RAG_EVAL_STALE_RUN_MS');

  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.equal(parseLastJsonLine(explicitResult.stdout), 900000);
});

test('server env exposes configurable RAG evaluation queue controls', () => {
  const defaultResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  }, `({
    interval: serverEnv.RAG_EVAL_QUEUE_INTERVAL_MS,
    concurrency: serverEnv.RAG_EVAL_QUEUE_CONCURRENCY,
    maxAttempts: serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS,
    retryBaseDelayMs: serverEnv.RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS,
    staleAfterMs: serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS
  })`);

  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.deepEqual(parseLastJsonLine(defaultResult.stdout), {
    interval: 5000,
    concurrency: 1,
    maxAttempts: 3,
    retryBaseDelayMs: 60000,
    staleAfterMs: 15 * 60 * 1000,
  });

  const explicitResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    RAG_EVAL_QUEUE_INTERVAL_MS: '2500',
    RAG_EVAL_QUEUE_CONCURRENCY: '2',
    RAG_EVAL_QUEUE_MAX_ATTEMPTS: '5',
    RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS: '30000',
    RAG_EVAL_QUEUE_STALE_AFTER_MS: '120000',
  }, `({
    interval: serverEnv.RAG_EVAL_QUEUE_INTERVAL_MS,
    concurrency: serverEnv.RAG_EVAL_QUEUE_CONCURRENCY,
    maxAttempts: serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS,
    retryBaseDelayMs: serverEnv.RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS,
    staleAfterMs: serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS
  })`);

  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.deepEqual(parseLastJsonLine(explicitResult.stdout), {
    interval: 2500,
    concurrency: 2,
    maxAttempts: 5,
    retryBaseDelayMs: 30000,
    staleAfterMs: 120000,
  });
});

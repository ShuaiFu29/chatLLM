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

const TEST_RAG_SERVICE_TOKEN = 'test-rag-service-token-at-least-32-characters';

function importServerEnv(overrides, expression = 'serverEnv.DATABASE_URL') {
  return spawnSync(
    process.execPath,
    ['-e', `const { serverEnv } = require(${JSON.stringify(envModulePath)}); console.log(JSON.stringify(${expression}));`],
    {
      cwd: serverRoot,
      env: {
        ...baseEnv,
        REDIS_URL: 'redis://localhost:6379/0',
        RAG_SERVICE_TOKEN: TEST_RAG_SERVICE_TOKEN,
        ...overrides,
      },
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
    REDIS_URL: '',
    S3_ENDPOINT: '',
    S3_ACCESS_KEY: '',
    S3_SECRET_KEY: '',
    JWT_SECRET: '',
    DEEPSEEK_API_KEY: '',
    MOONSHOT_API_KEY: '',
    QWEN_API_KEY: '',
    OPENAI_API_KEY: '',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required server environment variables: DATABASE_URL, REDIS_URL, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, JWT_SECRET/);
  assert.match(result.stderr, /At least one chat provider key is required: DEEPSEEK_API_KEY, MOONSHOT_API_KEY, QWEN_API_KEY/);
  assert.doesNotMatch(result.stderr, /OPENAI_API_KEY/);
});

test('server env does not accept official OpenAI key as a chat provider', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: '',
    MOONSHOT_API_KEY: '',
    QWEN_API_KEY: '',
    OPENAI_API_KEY: 'sk-test',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /At least one chat provider key is required: DEEPSEEK_API_KEY, MOONSHOT_API_KEY, QWEN_API_KEY/);
  assert.doesNotMatch(result.stderr, /gpt-|api\.openai\.com|OpenAI/);
});

test('server env rejects official provider model names as defaults', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    MOONSHOT_API_KEY: 'sk-test',
    DEFAULT_CHAT_MODEL: 'gpt-4o',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEFAULT_CHAT_MODEL must use a supported provider model/);
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

test('server env validates and exposes the Agent tool encryption keyring', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID: 'aug_2026',
    AGENT_TOOL_ENCRYPTION_KEYS: JSON.stringify({
      legacy_2025: '11'.repeat(32),
      aug_2026: '22'.repeat(32),
    }),
  }, `({
    active: serverEnv.AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID,
    ids: Object.keys(serverEnv.AGENT_TOOL_ENCRYPTION_KEYS).sort()
  })`);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseLastJsonLine(result.stdout), {
    active: 'aug_2026',
    ids: ['aug_2026', 'legacy_2025'],
  });
});

test('server env rejects ambiguous or malformed Agent tool encryption keyrings', () => {
  const required = {
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  };
  const noActive = importServerEnv({
    ...required,
    AGENT_TOOL_ENCRYPTION_KEYS: JSON.stringify({ old: '11'.repeat(32) }),
  });
  assert.notEqual(noActive.status, 0);
  assert.match(noActive.stderr, /AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID is required/);

  const missing = importServerEnv({
    ...required,
    AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID: 'missing',
    AGENT_TOOL_ENCRYPTION_KEYS: JSON.stringify({ old: '11'.repeat(32) }),
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /must select a configured encryption key/);

  const malformed = importServerEnv({
    ...required,
    AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID: 'active',
    AGENT_TOOL_ENCRYPTION_KEYS: '{not-json}',
  });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /must be a JSON object/);
});

test('server env exposes configured internal RAG and metrics tokens', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    RAG_SERVICE_TOKEN: TEST_RAG_SERVICE_TOKEN,
    METRICS_TOKEN: 'metrics-token',
  }, '({ rag: serverEnv.RAG_SERVICE_TOKEN, metrics: serverEnv.METRICS_TOKEN })');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseLastJsonLine(result.stdout), {
    rag: TEST_RAG_SERVICE_TOKEN,
    metrics: 'metrics-token',
  });
});

test('server env requires a strong RAG service token outside production too', () => {
  const missing = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    RAG_SERVICE_TOKEN: '',
  });

  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /RAG_SERVICE_TOKEN is required/);

  const weak = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    RAG_SERVICE_TOKEN: 'short-token',
  });

  assert.notEqual(weak.status, 0);
  assert.match(weak.stderr, /RAG_SERVICE_TOKEN must be at least 32 characters/);
});

test('server env requires internal service tokens in production', () => {
  const result = importServerEnv({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    RAG_SERVICE_TOKEN: '',
    METRICS_TOKEN: '',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RAG_SERVICE_TOKEN is required/);
  assert.match(result.stderr, /METRICS_TOKEN is required in production/);
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

test('server env defaults proxy trust to zero and accepts an explicit hop count', () => {
  const defaultResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    TRUST_PROXY_HOPS: '',
  }, 'serverEnv.TRUST_PROXY_HOPS');

  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(parseLastJsonLine(defaultResult.stdout), 0);

  const explicitResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    TRUST_PROXY_HOPS: '2',
  }, 'serverEnv.TRUST_PROXY_HOPS');

  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.equal(parseLastJsonLine(explicitResult.stdout), 2);
});

test('server env rejects malformed proxy hop counts', () => {
  for (const value of ['-1', '1.5', '1proxy', '9007199254740992']) {
    const result = importServerEnv({
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      DEEPSEEK_API_KEY: 'sk-test',
      TRUST_PROXY_HOPS: value,
    });

    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /TRUST_PROXY_HOPS must be a non-negative safe integer/);
  }
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

test('server env exposes configurable default chat model', () => {
  const defaultResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    DEFAULT_CHAT_MODEL: '',
  }, 'serverEnv.DEFAULT_CHAT_MODEL');

  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(parseLastJsonLine(defaultResult.stdout), null);

  const kimiResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    MOONSHOT_API_KEY: 'sk-test',
    DEFAULT_CHAT_MODEL: 'moonshot-v1-8k',
  }, 'serverEnv.DEFAULT_CHAT_MODEL');

  assert.equal(kimiResult.status, 0, kimiResult.stderr);
  assert.equal(parseLastJsonLine(kimiResult.stdout), 'moonshot-v1-8k');
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
  assert.equal(parseLastJsonLine(defaultResult.stdout), 300000);

  const explicitResult = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    FILE_QUEUE_INGEST_TIMEOUT_MS: '120000',
  }, 'serverEnv.FILE_QUEUE_INGEST_TIMEOUT_MS');

  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.equal(parseLastJsonLine(explicitResult.stdout), 120000);
});

test('server env rejects dangerously low RAG ingest timeout values', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    FILE_QUEUE_INGEST_TIMEOUT_MS: '10000',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FILE_QUEUE_INGEST_TIMEOUT_MS must be at least 60000/);
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

test('server env exposes strict document and per-user upload byte budgets', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    MAX_DOCUMENT_BYTES: '104857600',
    MAX_USER_STORAGE_BYTES: '1073741824',
    MAX_USER_ACTIVE_UPLOAD_BYTES: '209715200',
  }, `({
    document: serverEnv.MAX_DOCUMENT_BYTES,
    storage: serverEnv.MAX_USER_STORAGE_BYTES,
    active: serverEnv.MAX_USER_ACTIVE_UPLOAD_BYTES
  })`);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseLastJsonLine(result.stdout), {
    document: 104857600,
    storage: 1073741824,
    active: 209715200,
  });
});

test('server env rejects malformed or unsafe upload byte budgets', () => {
  for (const [key, value] of [
    ['MAX_DOCUMENT_BYTES', '10mb'],
    ['MAX_USER_STORAGE_BYTES', '1.5'],
    ['MAX_USER_ACTIVE_UPLOAD_BYTES', '9007199254740992'],
  ]) {
    const result = importServerEnv({
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      DEEPSEEK_API_KEY: 'sk-test',
      [key]: value,
    });

    assert.notEqual(result.status, 0, `${key}=${value}`);
    assert.match(result.stderr, new RegExp(`${key} must be a positive safe integer`));
  }
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
    staleAfterMs: serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS,
    caseTimeoutMs: serverEnv.RAG_EVAL_CASE_TIMEOUT_MS,
    runTimeoutMs: serverEnv.RAG_EVAL_RUN_TIMEOUT_MS
  })`);

  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.deepEqual(parseLastJsonLine(defaultResult.stdout), {
    interval: 5000,
    concurrency: 1,
    maxAttempts: 3,
    retryBaseDelayMs: 60000,
    staleAfterMs: 15 * 60 * 1000,
    caseTimeoutMs: 60000,
    runTimeoutMs: 30 * 60 * 1000,
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
    RAG_EVAL_CASE_TIMEOUT_MS: '45000',
    RAG_EVAL_RUN_TIMEOUT_MS: '600000',
  }, `({
    interval: serverEnv.RAG_EVAL_QUEUE_INTERVAL_MS,
    concurrency: serverEnv.RAG_EVAL_QUEUE_CONCURRENCY,
    maxAttempts: serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS,
    retryBaseDelayMs: serverEnv.RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS,
    staleAfterMs: serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS,
    caseTimeoutMs: serverEnv.RAG_EVAL_CASE_TIMEOUT_MS,
    runTimeoutMs: serverEnv.RAG_EVAL_RUN_TIMEOUT_MS
  })`);

  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.deepEqual(parseLastJsonLine(explicitResult.stdout), {
    interval: 2500,
    concurrency: 2,
    maxAttempts: 5,
    retryBaseDelayMs: 30000,
    staleAfterMs: 120000,
    caseTimeoutMs: 45000,
    runTimeoutMs: 600000,
  });
});

test('server env rejects an Eval case deadline longer than the whole-run deadline', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    RAG_EVAL_CASE_TIMEOUT_MS: '120000',
    RAG_EVAL_RUN_TIMEOUT_MS: '60000',
  }, 'serverEnv.RAG_EVAL_RUN_TIMEOUT_MS');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RAG_EVAL_RUN_TIMEOUT_MS must be at least RAG_EVAL_CASE_TIMEOUT_MS/);
});

test('server env rejects an Eval stale lease too short for safe heartbeats', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
    RAG_EVAL_QUEUE_STALE_AFTER_MS: '3000',
  }, 'serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RAG_EVAL_QUEUE_STALE_AFTER_MS must be at least 4000/);
});

test('server env caps Eval timers to PostgreSQL and Node timer ranges', () => {
  for (const [key, extra] of [
    ['RAG_EVAL_CASE_TIMEOUT_MS', { RAG_EVAL_RUN_TIMEOUT_MS: '2147483648' }],
    ['RAG_EVAL_RUN_TIMEOUT_MS', {}],
    ['RAG_EVAL_QUEUE_STALE_AFTER_MS', {}],
  ]) {
    const result = importServerEnv({
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      DEEPSEEK_API_KEY: 'sk-test',
      [key]: '2147483648',
      ...extra,
    }, `serverEnv.${key}`);

    assert.notEqual(result.status, 0, key);
    assert.match(result.stderr, new RegExp(`${key} must be at most 2147483647`));
  }
});

const BOOLEAN_ENV_BASE = {
  DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'minioadmin',
  S3_SECRET_KEY: 'minioadmin',
  JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
  DEEPSEEK_API_KEY: 'sk-test',
};

test('boolean env flags accept the usual spellings of both sides (P2-GETBOOLEAN)', () => {
  // `0` used to mean true, because the rule was "anything but the literal
  // string false".
  for (const [value, expected] of [
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['no', false],
    ['off', false],
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['on', true],
    [' 0 ', false],
  ]) {
    const result = importServerEnv(
      { ...BOOLEAN_ENV_BASE, S3_FORCE_PATH_STYLE: value },
      'serverEnv.S3_FORCE_PATH_STYLE',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      parseLastJsonLine(result.stdout),
      expected,
      `S3_FORCE_PATH_STYLE=${JSON.stringify(value)} should parse as ${expected}`,
    );
  }
});

test('an unrecognized boolean value fails startup instead of being guessed (P2-GETBOOLEAN)', () => {
  for (const key of ['S3_FORCE_PATH_STYLE', 'EMBEDDING_DEBUG_LOGS']) {
    const result = importServerEnv(
      { ...BOOLEAN_ENV_BASE, [key]: 'flase' },
      `serverEnv.${key}`,
    );
    assert.notEqual(result.status, 0, `${key} must reject an unparseable value`);
    assert.match(result.stderr, new RegExp(`${key} must be one of true/false`));
  }
});

test('an empty boolean value keeps the documented default (P2-GETBOOLEAN)', () => {
  const pathStyle = importServerEnv(
    { ...BOOLEAN_ENV_BASE, S3_FORCE_PATH_STYLE: '' },
    'serverEnv.S3_FORCE_PATH_STYLE',
  );
  assert.equal(pathStyle.status, 0, pathStyle.stderr);
  assert.equal(parseLastJsonLine(pathStyle.stdout), true);

  const debugLogs = importServerEnv(
    { ...BOOLEAN_ENV_BASE, EMBEDDING_DEBUG_LOGS: '   ' },
    'serverEnv.EMBEDDING_DEBUG_LOGS',
  );
  assert.equal(debugLogs.status, 0, debugLogs.stderr);
  assert.equal(parseLastJsonLine(debugLogs.stdout), false);
});

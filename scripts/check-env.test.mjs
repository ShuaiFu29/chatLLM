import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseEnvContent,
  validateEnvMap,
  validateProjectEnvMaps as validateProjectEnvMapsRaw,
} from './check-env.mjs';

const TEST_RAG_SERVICE_TOKEN = 'test-rag-service-token-at-least-32-characters';

const validateProjectEnvMaps = (envMaps) => validateProjectEnvMapsRaw({
  ...envMaps,
  'server/.env': {
    RAG_SERVICE_TOKEN: TEST_RAG_SERVICE_TOKEN,
    ...(envMaps['server/.env'] || {}),
  },
  'rag-service/.env': {
    RAG_SERVICE_TOKEN: TEST_RAG_SERVICE_TOKEN,
    ...(envMaps['rag-service/.env'] || {}),
  },
});

test('parseEnvContent parses keys and ignores comments without exposing values', () => {
  const env = parseEnvContent(`
# comment
DATABASE_URL=postgres://user:pass@localhost/db
JWT_SECRET="secret"
EMPTY=
`);

  assert.deepEqual(Object.keys(env), ['DATABASE_URL', 'JWT_SECRET', 'EMPTY']);
  assert.equal(env.DATABASE_URL, 'postgres://user:pass@localhost/db');
  assert.equal(env.JWT_SECRET, 'secret');
  assert.equal(env.EMPTY, '');
});

test('validateEnvMap reports missing required key names', () => {
  const issues = validateEnvMap('server/.env', { DATABASE_URL: '' }, {
    required: ['DATABASE_URL', 'S3_ENDPOINT'],
  });

  assert.deepEqual(issues, [
    'server/.env is missing required keys: DATABASE_URL, S3_ENDPOINT',
  ]);
});

test('validateEnvMap rejects forbidden Supabase keys', () => {
  const issues = validateEnvMap('rag-service/.env', {
    DATABASE_URL: 'postgres://localhost/db',
    SUPABASE_URL: 'https://example.supabase.co',
  }, {
    required: ['DATABASE_URL'],
    forbiddenPrefixes: ['SUPABASE_'],
  });

  assert.deepEqual(issues, [
    'rag-service/.env contains unsupported keys: SUPABASE_URL',
  ]);
});

test('validateProjectEnvMaps rejects official OpenAI keys as unsupported provider config', () => {
  const issues = validateProjectEnvMaps({
    'server/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      OPENAI_API_KEY: 'sk-test',
    },
    'rag-service/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      MILVUS_URI: 'http://localhost:19530',
      MILVUS_COLLECTION: 'document_chunks',
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_DIMENSION: '1024',
    },
  });

  assert.deepEqual(issues, [
    'server/.env contains unsupported keys: OPENAI_API_KEY',
    'server/.env must define at least one of: DEEPSEEK_API_KEY, MOONSHOT_API_KEY, QWEN_API_KEY',
  ]);
});

test('validateProjectEnvMaps rejects official provider model names as defaults', () => {
  const issues = validateProjectEnvMaps({
    'server/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      MOONSHOT_API_KEY: 'sk-test',
      DEFAULT_CHAT_MODEL: 'gpt-4o',
    },
    'rag-service/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      MILVUS_URI: 'http://localhost:19530',
      MILVUS_COLLECTION: 'document_chunks',
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_DIMENSION: '1024',
    },
  });

  assert.deepEqual(issues, [
    'server/.env DEFAULT_CHAT_MODEL must use a supported provider model such as deepseek-chat, moonshot-v1-8k, or qwen-plus',
  ]);
});

test('validateEnvMap rejects weak JWT placeholder secrets', () => {
  const issues = validateEnvMap('server/.env', {
    DATABASE_URL: 'postgres://localhost/db',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'super-secret-jwt-key-change-me',
    DEEPSEEK_API_KEY: 'sk-test',
  }, {
    required: ['DATABASE_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'JWT_SECRET'],
    forbiddenPrefixes: ['SUPABASE_'],
    jwtSecretKey: 'JWT_SECRET',
    atLeastOne: [['DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'QWEN_API_KEY']],
  });

  assert.deepEqual(issues, [
    'server/.env has an unsafe JWT_SECRET placeholder; replace it with a long random secret',
  ]);
});

test('validateProjectEnvMaps accepts valid server and RAG env maps', () => {
  const issues = validateProjectEnvMaps({
    'server/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      DEEPSEEK_API_KEY: 'sk-test',
    },
    'rag-service/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      MILVUS_URI: 'http://localhost:19530',
      MILVUS_COLLECTION: 'document_chunks',
      EMBEDDING_API_KEY: 'embedding-key',
      EMBEDDING_BASE_URL: 'https://llm-ro9cl3th56gnvkzo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      EMBEDDING_MODEL: 'text-embedding-v4',
      EMBEDDING_DIMENSION: '1024',
    },
  });

  assert.deepEqual(issues, []);
});

test('validateProjectEnvMaps requires one matching strong RAG service token', () => {
  const validServer = {
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  };
  const validRag = {
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    MILVUS_URI: 'http://localhost:19530',
    MILVUS_COLLECTION: 'document_chunks',
    EMBEDDING_PROVIDER: 'local',
    EMBEDDING_DIMENSION: '1024',
  };

  const missing = validateProjectEnvMapsRaw({
    'server/.env': validServer,
    'rag-service/.env': validRag,
  });
  assert.ok(missing.some((issue) => /server\/\.env.*RAG_SERVICE_TOKEN/.test(issue)));
  assert.ok(missing.some((issue) => /rag-service\/\.env.*RAG_SERVICE_TOKEN/.test(issue)));

  const weak = validateProjectEnvMapsRaw({
    'server/.env': { ...validServer, RAG_SERVICE_TOKEN: 'server-short' },
    'rag-service/.env': { ...validRag, RAG_SERVICE_TOKEN: 'rag-short' },
  });
  assert.ok(weak.some((issue) => /RAG_SERVICE_TOKEN must be at least 32 characters/.test(issue)));

  const serverToken = 'server-rag-service-token-at-least-32-characters';
  const ragToken = 'different-rag-service-token-at-least-32-characters';
  const mismatched = validateProjectEnvMapsRaw({
    'server/.env': { ...validServer, RAG_SERVICE_TOKEN: serverToken },
    'rag-service/.env': { ...validRag, RAG_SERVICE_TOKEN: ragToken },
  });
  assert.ok(mismatched.some((issue) => /must match/.test(issue)));
  assert.doesNotMatch(mismatched.join('\n'), new RegExp(serverToken));
  assert.doesNotMatch(mismatched.join('\n'), new RegExp(ragToken));
});

test('validateProjectEnvMaps rejects dangerously low file queue ingest timeouts', () => {
  const issues = validateProjectEnvMaps({
    'server/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      QWEN_API_KEY: 'sk-test',
      FILE_QUEUE_INGEST_TIMEOUT_MS: '10000',
    },
    'rag-service/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      MILVUS_URI: 'http://localhost:19530',
      MILVUS_COLLECTION: 'document_chunks',
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_DIMENSION: '1024',
    },
  });

  assert.deepEqual(issues, [
    'server/.env FILE_QUEUE_INGEST_TIMEOUT_MS should be at least 60000 for synchronous RAG ingestion',
  ]);
});

test('validateProjectEnvMaps accepts Qwen as the only configured chat provider', () => {
  const issues = validateProjectEnvMaps({
    'server/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      QWEN_API_KEY: 'sk-test',
    },
    'rag-service/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      MILVUS_URI: 'http://localhost:19530',
      MILVUS_COLLECTION: 'document_chunks',
      EMBEDDING_API_KEY: 'embedding-key',
      EMBEDDING_BASE_URL: 'https://llm-ro9cl3th56gnvkzo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      EMBEDDING_MODEL: 'text-embedding-v4',
      EMBEDDING_DIMENSION: '1024',
    },
  });

  assert.deepEqual(issues, []);
});

test('validateProjectEnvMaps accepts explicit local RAG embeddings without external provider keys', () => {
  const issues = validateProjectEnvMaps({
    'server/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      DEEPSEEK_API_KEY: 'sk-test',
    },
    'rag-service/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      MILVUS_URI: 'http://localhost:19530',
      MILVUS_COLLECTION: 'document_chunks',
      EMBEDDING_PROVIDER: 'LOCAL',
      EMBEDDING_DIMENSION: '1024',
    },
  });

  assert.deepEqual(issues, []);
});

test('validateProjectEnvMaps requires Kimi judge settings only when RAG judge is enabled', () => {
  const base = {
    'server/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      MOONSHOT_API_KEY: 'sk-test',
    },
    'rag-service/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      MILVUS_URI: 'http://localhost:19530',
      MILVUS_COLLECTION: 'document_chunks',
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_DIMENSION: '1024',
      RAG_JUDGE_ENABLED: 'true',
    },
  };

  assert.deepEqual(validateProjectEnvMaps(base), [
    'rag-service/.env is missing required keys: RAG_JUDGE_API_KEY, RAG_JUDGE_BASE_URL, RAG_JUDGE_MODEL',
  ]);

  assert.deepEqual(validateProjectEnvMaps({
    ...base,
    'rag-service/.env': {
      ...base['rag-service/.env'],
      RAG_JUDGE_API_KEY: 'sk-test',
      RAG_JUDGE_BASE_URL: 'https://api.moonshot.cn/v1',
      RAG_JUDGE_MODEL: 'moonshot-v1-8k',
    },
  }), []);
});

test('validateProjectEnvMaps rejects mismatched localhost backend port', () => {
  const issues = validateProjectEnvMaps({
    'server/.env': {
      PORT: '3002',
      BACKEND_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
      DEEPSEEK_API_KEY: 'sk-test',
    },
    'rag-service/.env': {
      DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      MILVUS_URI: 'http://localhost:19530',
      MILVUS_COLLECTION: 'document_chunks',
      EMBEDDING_API_KEY: 'embedding-key',
      EMBEDDING_BASE_URL: 'https://llm-ro9cl3th56gnvkzo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      EMBEDDING_MODEL: 'text-embedding-v4',
      EMBEDDING_DIMENSION: '1024',
    },
  });

  assert.deepEqual(issues, [
    'server/.env BACKEND_URL port must match PORT for localhost URLs',
  ]);
});

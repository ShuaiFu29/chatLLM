import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseEnvContent,
  validateEnvMap,
  validateProjectEnvMaps,
} from './check-env.mjs';

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
    atLeastOne: [['DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'OPENAI_API_KEY']],
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
      EMBEDDING_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4/',
      EMBEDDING_MODEL: 'embedding-2',
      EMBEDDING_DIMENSION: '1024',
    },
  });

  assert.deepEqual(issues, []);
});

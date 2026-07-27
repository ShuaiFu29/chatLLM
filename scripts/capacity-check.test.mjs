import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCapacityReport,
  validateCapacityConfig,
} from './capacity-check.mjs';

const enterpriseInfrastructureEnv = {
  INFRA_BIND_HOST: '127.0.0.1',
  REDIS_PASSWORD: 'test-redis-password-at-least-32-characters',
  POSTGRES_DB: 'chatllm',
  POSTGRES_USER: 'test-postgres-user',
  POSTGRES_PASSWORD: 'test-postgres-password-at-least-32-characters',
  MINIO_ROOT_USER: 'test-minio-root-user',
  MINIO_ROOT_PASSWORD: 'test-minio-password-at-least-32-characters',
  MILVUS_MINIO_ROOT_USER: 'test-milvus-minio-root-user',
  MILVUS_MINIO_ROOT_PASSWORD: 'test-milvus-minio-password-at-least-32-characters',
  NEO4J_USER: 'neo4j',
  NEO4J_PASSWORD: 'test-neo4j-password-at-least-32-characters',
};

const enterpriseServerEnv = {
  DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
  REDIS_URL: 'redis://:test-redis-password-at-least-32-characters@localhost:6379/0',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'minioadmin',
  S3_SECRET_KEY: 'minioadmin',
  JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
  QWEN_API_KEY: 'sk-test',
  RAG_SERVICE_TOKEN: 'test-rag-service-token-at-least-32-characters',
  DB_POOL_MAX: '30',
  DB_QUERY_TIMEOUT_MS: '15000',
  DB_SLOW_QUERY_THRESHOLD_MS: '500',
  FILE_QUEUE_CONCURRENCY: '6',
  FILE_QUEUE_INGEST_TIMEOUT_MS: '60000',
  FILE_QUEUE_MAX_ATTEMPTS: '5',
  FILE_QUEUE_STALE_AFTER_MS: '720000',
  RAG_EVAL_QUEUE_CONCURRENCY: '2',
  RAG_EVAL_QUEUE_STALE_AFTER_MS: '840000',
  RAG_HEALTH_TIMEOUT_MS: '10000',
  RAG_RETRIEVE_TIMEOUT_MS: '30000',
  RAG_RETRIEVE_MAX_ATTEMPTS: '2',
  RAG_RETRIEVE_TOTAL_TIMEOUT_MS: '60000',
  RAG_CIRCUIT_FAILURE_THRESHOLD: '5',
  CHAT_STREAM_MAX_CONCURRENT: '80',
  CHAT_STREAM_MAX_CONCURRENT_PER_USER: '5',
  MAX_DOCUMENT_BYTES: '104857600',
  MAX_USER_STORAGE_BYTES: '10737418240',
  MAX_USER_ACTIVE_UPLOAD_BYTES: '1073741824',
};

const enterpriseRagEnv = {
  DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'minioadmin',
  S3_SECRET_KEY: 'minioadmin',
  MILVUS_URI: 'http://localhost:19530',
  MILVUS_COLLECTION: 'document_chunks',
  MILVUS_INDEX_TYPE: 'HNSW',
  MILVUS_HNSW_M: '32',
  MILVUS_HNSW_EF_CONSTRUCTION: '300',
  MILVUS_SEARCH_EF: '128',
  MILVUS_INSERT_BATCH_SIZE: '500',
  ELASTICSEARCH_ENABLED: 'true',
  ELASTICSEARCH_URL: 'http://localhost:9200',
  ELASTICSEARCH_INDEX: 'chatllm_chunks',
  ELASTICSEARCH_NUMBER_OF_SHARDS: '1',
  ELASTICSEARCH_NUMBER_OF_REPLICAS: '0',
  ELASTICSEARCH_BULK_BATCH_SIZE: '500',
  NEO4J_ENABLED: 'true',
  NEO4J_URL: 'http://localhost:7474',
  NEO4J_USER: 'neo4j',
  NEO4J_PASSWORD: 'chatllm-password',
  NEO4J_TIMEOUT_MS: '15000',
  NEO4J_BATCH_SIZE: '100',
  EMBEDDING_API_KEY: 'embedding-key',
  EMBEDDING_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  EMBEDDING_MODEL: 'text-embedding-v4',
  EMBEDDING_DIMENSION: '1024',
  RAG_INGEST_CONCURRENCY: '6',
  RAG_INGEST_STREAMING_THRESHOLD_BYTES: '52428800',
  RAG_INGEST_CHUNK_BATCH_SIZE: '100',
  RAG_INGEST_EMBEDDING_BATCH_SIZE: '10',
  RAG_READINESS_TIMEOUT_MS: '2000',
  RAG_SERVICE_TOKEN: 'test-rag-service-token-at-least-32-characters',
  RAG_DB_POOL_MAX: '12',
  RAG_DB_POOL_TIMEOUT_MS: '4500',
};

const tunedCompose = `
services:
  elasticsearch:
    environment:
      - bootstrap.memory_lock=true
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
    ulimits:
      memlock:
        soft: -1
        hard: -1
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:9200/_cluster/health || exit 1"]
  neo4j:
    environment:
      NEO4J_server_memory_heap_initial__size: 512m
      NEO4J_server_memory_heap_max__size: 1G
      NEO4J_server_memory_pagecache_size: 512m
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://localhost:7474 || exit 1"]
  milvus-standalone:
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:9091/healthz || exit 1"]
`;

test('validateCapacityConfig accepts an enterprise-oriented capacity profile', () => {
  const report = validateCapacityConfig({
    envMaps: {
      '.env': enterpriseInfrastructureEnv,
      'server/.env': enterpriseServerEnv,
      'rag-service/.env': enterpriseRagEnv,
    },
    composeText: tunedCompose,
    profile: 'enterprise',
  });

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test('validateCapacityConfig reports quota, lease, and RAG database pool settings', () => {
  const report = validateCapacityConfig({
    envMaps: {
      '.env': enterpriseInfrastructureEnv,
      'server/.env': enterpriseServerEnv,
      'rag-service/.env': enterpriseRagEnv,
    },
    composeText: tunedCompose,
    profile: 'enterprise',
  });
  const details = Object.fromEntries(report.checks.map((check) => [check.label, check.detail]));

  assert.equal(details.MAX_DOCUMENT_BYTES, 'MAX_DOCUMENT_BYTES=104857600');
  assert.equal(details.MAX_USER_STORAGE_BYTES, 'MAX_USER_STORAGE_BYTES=10737418240');
  assert.equal(details.MAX_USER_ACTIVE_UPLOAD_BYTES, 'MAX_USER_ACTIVE_UPLOAD_BYTES=1073741824');
  assert.equal(details.FILE_QUEUE_STALE_AFTER_MS, 'FILE_QUEUE_STALE_AFTER_MS=720000');
  assert.equal(details.RAG_EVAL_QUEUE_STALE_AFTER_MS, 'RAG_EVAL_QUEUE_STALE_AFTER_MS=840000');
  assert.equal(details.RAG_DB_POOL_MAX, 'RAG_DB_POOL_MAX=12');
  assert.equal(details.RAG_DB_POOL_TIMEOUT_MS, 'RAG_DB_POOL_TIMEOUT_MS=4500');
});

test('validateCapacityConfig reports risky bottleneck settings for enterprise mode', () => {
  const report = validateCapacityConfig({
    envMaps: {
      '.env': enterpriseInfrastructureEnv,
      'server/.env': {
        ...enterpriseServerEnv,
        DB_POOL_MAX: '5',
        FILE_QUEUE_CONCURRENCY: '4',
        CHAT_STREAM_MAX_CONCURRENT: '10',
      },
      'rag-service/.env': {
        ...enterpriseRagEnv,
        ELASTICSEARCH_ENABLED: 'false',
        NEO4J_ENABLED: 'false',
        RAG_INGEST_CONCURRENCY: '2',
        RAG_INGEST_STREAMING_THRESHOLD_BYTES: '1073741824',
        RAG_INGEST_CHUNK_BATCH_SIZE: '5000',
        RAG_INGEST_EMBEDDING_BATCH_SIZE: '200',
        NEO4J_TIMEOUT_MS: '3000',
        NEO4J_BATCH_SIZE: '500',
        MILVUS_SEARCH_EF: '16',
        MILVUS_INSERT_BATCH_SIZE: '5000',
      },
    },
    composeText: 'services: {}',
    profile: 'enterprise',
  });

  assert.deepEqual(report.errors, []);
  assert.match(report.warnings.join('\n'), /DB_POOL_MAX should be >= 20/);
  assert.match(report.warnings.join('\n'), /CHAT_STREAM_MAX_CONCURRENT should be >= 50/);
  assert.match(report.warnings.join('\n'), /ELASTICSEARCH_ENABLED should be true/);
  assert.match(report.warnings.join('\n'), /NEO4J_ENABLED should be true/);
  assert.match(report.warnings.join('\n'), /MILVUS_SEARCH_EF should be >= 64/);
  assert.match(report.warnings.join('\n'), /MILVUS_INSERT_BATCH_SIZE should be <= 1000/);
  assert.match(report.warnings.join('\n'), /RAG_INGEST_CONCURRENCY should be >= FILE_QUEUE_CONCURRENCY/);
  assert.match(report.warnings.join('\n'), /RAG_INGEST_STREAMING_THRESHOLD_BYTES should be <= 104857600/);
  assert.match(report.warnings.join('\n'), /RAG_INGEST_CHUNK_BATCH_SIZE should be <= 1000/);
  assert.match(report.warnings.join('\n'), /RAG_INGEST_EMBEDDING_BATCH_SIZE should be <= 64/);
  assert.match(report.warnings.join('\n'), /NEO4J_TIMEOUT_MS should be >= 10000/);
  assert.match(report.warnings.join('\n'), /NEO4J_BATCH_SIZE should be <= 200/);
  assert.match(report.warnings.join('\n'), /docker-compose.yml should tune Elasticsearch JVM heap/);
  assert.match(report.warnings.join('\n'), /docker-compose.yml should tune Neo4j heap and page cache/);
});

test('buildCapacityReport renders a concise operator-facing summary', () => {
  const report = buildCapacityReport({
    errors: [],
    warnings: ['DB_POOL_MAX should be >= 20 for enterprise profile'],
    checks: [
      { label: 'Postgres pool', status: 'warn', detail: 'DB_POOL_MAX=5' },
      { label: 'Milvus index', status: 'ok', detail: 'HNSW / COSINE' },
    ],
  });

  assert.match(report, /Capacity check completed/);
  assert.match(report, /WARN Postgres pool - DB_POOL_MAX=5/);
  assert.match(report, /OK Milvus index - HNSW \/ COSINE/);
  assert.match(report, /Warnings:/);
});

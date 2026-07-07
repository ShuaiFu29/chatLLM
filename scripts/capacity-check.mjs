import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readProjectEnvMaps, validateProjectEnvMaps } from './check-env.mjs';

const asInt = (env, key, fallback = 0) => {
  const parsed = Number.parseInt(env[key] || '', 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const asBool = (env, key, fallback = false) => {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() !== 'false';
};

const addThresholdWarning = (warnings, checks, label, value, operator, threshold, detail) => {
  const ok = operator === '>=' ? value >= threshold : value <= threshold;
  checks.push({
    label,
    status: ok ? 'ok' : 'warn',
    detail,
  });
  if (!ok) warnings.push(`${label} should be ${operator} ${threshold} for enterprise profile (${detail})`);
};

export function validateCapacityConfig({ envMaps, composeText = '', profile = 'dev' }) {
  const errors = [...validateProjectEnvMaps(envMaps)];
  const warnings = [];
  const checks = [];
  const serverEnv = envMaps['server/.env'] || {};
  const ragEnv = envMaps['rag-service/.env'] || {};
  const enterprise = profile === 'enterprise';

  const dbPoolMax = asInt(serverEnv, 'DB_POOL_MAX', 10);
  const fileQueueConcurrency = asInt(serverEnv, 'FILE_QUEUE_CONCURRENCY', 2);
  const fileQueueMaxAttempts = asInt(serverEnv, 'FILE_QUEUE_MAX_ATTEMPTS', 3);
  const chatMaxConcurrent = asInt(serverEnv, 'CHAT_STREAM_MAX_CONCURRENT', 20);
  const ragEvalConcurrency = asInt(serverEnv, 'RAG_EVAL_QUEUE_CONCURRENCY', 1);
  const ragRetrieveTimeoutMs = asInt(serverEnv, 'RAG_RETRIEVE_TIMEOUT_MS', 10000);
  const ragCircuitThreshold = asInt(serverEnv, 'RAG_CIRCUIT_FAILURE_THRESHOLD', 5);
  const ragIngestConcurrency = asInt(ragEnv, 'RAG_INGEST_CONCURRENCY', 2);

  if (enterprise) {
    addThresholdWarning(warnings, checks, 'DB_POOL_MAX', dbPoolMax, '>=', 20, `DB_POOL_MAX=${dbPoolMax}`);
    addThresholdWarning(
      warnings,
      checks,
      'FILE_QUEUE_CONCURRENCY',
      fileQueueConcurrency,
      '>=',
      4,
      `FILE_QUEUE_CONCURRENCY=${fileQueueConcurrency}`
    );
    addThresholdWarning(
      warnings,
      checks,
      'CHAT_STREAM_MAX_CONCURRENT',
      chatMaxConcurrent,
      '>=',
      50,
      `CHAT_STREAM_MAX_CONCURRENT=${chatMaxConcurrent}`
    );
  } else {
    checks.push({ label: 'DB_POOL_MAX', status: 'ok', detail: `DB_POOL_MAX=${dbPoolMax}` });
    checks.push({ label: 'FILE_QUEUE_CONCURRENCY', status: 'ok', detail: `FILE_QUEUE_CONCURRENCY=${fileQueueConcurrency}` });
    checks.push({ label: 'CHAT_STREAM_MAX_CONCURRENT', status: 'ok', detail: `CHAT_STREAM_MAX_CONCURRENT=${chatMaxConcurrent}` });
  }

  checks.push({ label: 'FILE_QUEUE_MAX_ATTEMPTS', status: 'ok', detail: `FILE_QUEUE_MAX_ATTEMPTS=${fileQueueMaxAttempts}` });
  checks.push({ label: 'RAG_EVAL_QUEUE_CONCURRENCY', status: 'ok', detail: `RAG_EVAL_QUEUE_CONCURRENCY=${ragEvalConcurrency}` });
  const ragIngestMatchesFileQueue = ragIngestConcurrency >= fileQueueConcurrency;
  checks.push({
    label: 'RAG_INGEST_CONCURRENCY',
    status: ragIngestMatchesFileQueue ? 'ok' : 'warn',
    detail: `RAG_INGEST_CONCURRENCY=${ragIngestConcurrency}, FILE_QUEUE_CONCURRENCY=${fileQueueConcurrency}`,
  });
  if (enterprise && !ragIngestMatchesFileQueue) {
    warnings.push(
      `RAG_INGEST_CONCURRENCY should be >= FILE_QUEUE_CONCURRENCY for enterprise profile (RAG_INGEST_CONCURRENCY=${ragIngestConcurrency}, FILE_QUEUE_CONCURRENCY=${fileQueueConcurrency})`
    );
  }
  checks.push({ label: 'RAG_RETRIEVE_TIMEOUT_MS', status: 'ok', detail: `RAG_RETRIEVE_TIMEOUT_MS=${ragRetrieveTimeoutMs}` });
  checks.push({ label: 'RAG_CIRCUIT_FAILURE_THRESHOLD', status: 'ok', detail: `RAG_CIRCUIT_FAILURE_THRESHOLD=${ragCircuitThreshold}` });

  const esEnabled = asBool(ragEnv, 'ELASTICSEARCH_ENABLED', true);
  const neo4jEnabled = asBool(ragEnv, 'NEO4J_ENABLED', true);
  const milvusSearchEf = asInt(ragEnv, 'MILVUS_SEARCH_EF', 64);
  const milvusBatchSize = asInt(ragEnv, 'MILVUS_INSERT_BATCH_SIZE', 500);
  const esBatchSize = asInt(ragEnv, 'ELASTICSEARCH_BULK_BATCH_SIZE', 500);
  const neo4jTimeoutMs = asInt(ragEnv, 'NEO4J_TIMEOUT_MS', 15000);
  const neo4jBatchSize = asInt(ragEnv, 'NEO4J_BATCH_SIZE', 100);

  if (enterprise && !esEnabled) warnings.push('ELASTICSEARCH_ENABLED should be true for enterprise hybrid retrieval');
  checks.push({
    label: 'Elasticsearch BM25',
    status: esEnabled ? 'ok' : 'warn',
    detail: `ELASTICSEARCH_ENABLED=${esEnabled}`,
  });

  if (enterprise && !neo4jEnabled) warnings.push('NEO4J_ENABLED should be true for enterprise graph retrieval');
  checks.push({
    label: 'Neo4j graph retrieval',
    status: neo4jEnabled ? 'ok' : 'warn',
    detail: `NEO4J_ENABLED=${neo4jEnabled}`,
  });

  if (enterprise) {
    addThresholdWarning(warnings, checks, 'MILVUS_SEARCH_EF', milvusSearchEf, '>=', 64, `MILVUS_SEARCH_EF=${milvusSearchEf}`);
    addThresholdWarning(
      warnings,
      checks,
      'MILVUS_INSERT_BATCH_SIZE',
      milvusBatchSize,
      '<=',
      1000,
      `MILVUS_INSERT_BATCH_SIZE=${milvusBatchSize}`
    );
  } else {
    checks.push({ label: 'MILVUS_SEARCH_EF', status: 'ok', detail: `MILVUS_SEARCH_EF=${milvusSearchEf}` });
    checks.push({ label: 'MILVUS_INSERT_BATCH_SIZE', status: 'ok', detail: `MILVUS_INSERT_BATCH_SIZE=${milvusBatchSize}` });
  }

  checks.push({ label: 'ELASTICSEARCH_BULK_BATCH_SIZE', status: 'ok', detail: `ELASTICSEARCH_BULK_BATCH_SIZE=${esBatchSize}` });
  if (enterprise) {
    addThresholdWarning(warnings, checks, 'NEO4J_TIMEOUT_MS', neo4jTimeoutMs, '>=', 10000, `NEO4J_TIMEOUT_MS=${neo4jTimeoutMs}`);
    addThresholdWarning(warnings, checks, 'NEO4J_BATCH_SIZE', neo4jBatchSize, '<=', 200, `NEO4J_BATCH_SIZE=${neo4jBatchSize}`);
  } else {
    checks.push({ label: 'NEO4J_TIMEOUT_MS', status: 'ok', detail: `NEO4J_TIMEOUT_MS=${neo4jTimeoutMs}` });
    checks.push({ label: 'NEO4J_BATCH_SIZE', status: 'ok', detail: `NEO4J_BATCH_SIZE=${neo4jBatchSize}` });
  }

  const hasEsHeap = /ES_JAVA_OPTS=-Xms\d+[gGmM]\s+-Xmx\d+[gGmM]/.test(composeText);
  const hasEsMemlock = /bootstrap\.memory_lock=true/.test(composeText) && /memlock:/.test(composeText);
  const hasNeo4jMemory = /NEO4J_server_memory_heap_initial__size=/.test(composeText)
    && /NEO4J_server_memory_heap_max__size=/.test(composeText)
    && /NEO4J_server_memory_pagecache_size=/.test(composeText);
  const hasMilvusHealth = /milvus-standalone:[\s\S]*?healthcheck:/.test(composeText);

  checks.push({ label: 'Elasticsearch JVM heap', status: hasEsHeap ? 'ok' : 'warn', detail: hasEsHeap ? 'configured' : 'missing' });
  checks.push({ label: 'Elasticsearch memlock', status: hasEsMemlock ? 'ok' : 'warn', detail: hasEsMemlock ? 'configured' : 'missing' });
  checks.push({ label: 'Neo4j memory', status: hasNeo4jMemory ? 'ok' : 'warn', detail: hasNeo4jMemory ? 'configured' : 'missing' });
  checks.push({ label: 'Milvus healthcheck', status: hasMilvusHealth ? 'ok' : 'warn', detail: hasMilvusHealth ? 'configured' : 'missing' });

  if (enterprise && !hasEsHeap) warnings.push('docker-compose.yml should tune Elasticsearch JVM heap for enterprise profile');
  if (enterprise && !hasEsMemlock) warnings.push('docker-compose.yml should enable Elasticsearch memory lock for enterprise profile');
  if (enterprise && !hasNeo4jMemory) warnings.push('docker-compose.yml should tune Neo4j heap and page cache for enterprise profile');
  if (enterprise && !hasMilvusHealth) warnings.push('docker-compose.yml should keep Milvus healthchecks enabled for enterprise profile');

  return { profile, errors, warnings, checks };
}

export function buildCapacityReport(report) {
  const lines = ['Capacity check completed.'];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.label} - ${check.detail}`);
  }

  if (report.errors.length > 0) {
    lines.push('', 'Errors:');
    for (const error of report.errors) lines.push(`- ${error}`);
  }

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }

  return lines.join('\n');
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).pathname : '';

if (pathToFileURL(currentFile).pathname === invokedFile) {
  const rootDir = process.cwd();
  const { envMaps, issues } = readProjectEnvMaps(rootDir);
  const composePath = path.join(rootDir, 'docker-compose.yml');
  const composeText = fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf8') : '';
  const report = validateCapacityConfig({
    envMaps,
    composeText,
    profile: process.env.CAPACITY_PROFILE || 'dev',
  });
  report.errors.unshift(...issues);

  console.log(buildCapacityReport(report));

  if (report.errors.length > 0 || (process.env.CAPACITY_STRICT === 'true' && report.warnings.length > 0)) {
    process.exitCode = 1;
  }
}

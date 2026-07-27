import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildOpsReport,
  buildOpsTargets,
  hasFailedOpsChecks,
  runOpsChecks,
} from './ops-check.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const composeSource = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const rootEnvExampleUrl = new URL('../.env.example', import.meta.url);
const rootEnvExample = fs.existsSync(rootEnvExampleUrl)
  ? fs.readFileSync(rootEnvExampleUrl, 'utf8')
  : '';
const serverEnvExample = fs.readFileSync(new URL('../server/.env.example', import.meta.url), 'utf8');
const ragEnvExample = fs.readFileSync(new URL('../rag-service/.env.example', import.meta.url), 'utf8');
const readmeSource = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const isolatedEnvFiles = { serverEnv: {}, ragEnv: {} };
const testOpsEnv = {
  OPS_METRICS_TOKEN: 'metrics-token-for-ops-tests',
  OPS_RAG_TOKEN: 'rag-token-for-ops-tests-at-least-32-characters',
};

test('docker compose binds every published infrastructure port to loopback by default', () => {
  const expectedPorts = [
    '6379:6379',
    '6380:6379',
    '5432:5432',
    '9000:9000',
    '9001:9001',
    '9200:9200',
    '7474:7474',
    '7687:7687',
    '19530:19530',
    '9091:9091',
    '3001:3000',
  ];
  const publishedPorts = [...composeSource.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)]
    .map((match) => match[1].replace('${CACHE_REDIS_PORT:-6380}', '6380'))
    .filter((value) => /(?:^|:)\d+:\d+$/.test(value));

  assert.deepEqual(
    publishedPorts,
    expectedPorts.map((port) => `\${INFRA_BIND_HOST:-127.0.0.1}:${port}`),
  );
});

test('docker compose requires external infrastructure credentials and documents generation', () => {
  const requiredVariables = [
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'MINIO_ROOT_USER',
    'MINIO_ROOT_PASSWORD',
    'MILVUS_MINIO_ROOT_USER',
    'MILVUS_MINIO_ROOT_PASSWORD',
    'NEO4J_USER',
    'NEO4J_PASSWORD',
  ];

  for (const variable of requiredVariables) {
    assert.match(composeSource, new RegExp(`\\$\\{${variable}:\\?${variable} is required\\}`));
    assert.match(rootEnvExample, new RegExp(`^${variable}=`, 'm'));
  }

  assert.match(rootEnvExample, /openssl rand -hex 32/);
  assert.doesNotMatch(composeSource, /POSTGRES_PASSWORD:\s*chatllm\b/);
  assert.doesNotMatch(composeSource, /MINIO_(?:ROOT_PASSWORD|SECRET_ACCESS_KEY):\s*minioadmin\b/);
  assert.doesNotMatch(composeSource, /NEO4J_AUTH=neo4j\/chatllm-password/);
  assert.doesNotMatch(rootEnvExample, /^POSTGRES_PASSWORD=chatllm\s*$/m);
  assert.doesNotMatch(rootEnvExample, /^(?:MINIO_ROOT_(?:USER|PASSWORD)|MILVUS_MINIO_ROOT_(?:USER|PASSWORD))=minioadmin\s*$/m);
  assert.doesNotMatch(rootEnvExample, /^NEO4J_PASSWORD=chatllm-password\s*$/m);
});

test('docker compose renders with the documented secure example configuration', () => {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', '.env.example', 'config', '--quiet'],
    { cwd: rootDir, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});

test('configuration examples and README document secure lifecycle operations', () => {
  const serverVariables = [
    'S3_REGION',
    'TRUST_PROXY_HOPS',
    'MAX_DOCUMENT_BYTES',
    'MAX_USER_STORAGE_BYTES',
    'MAX_USER_ACTIVE_UPLOAD_BYTES',
    'MULTIPART_UPLOAD_PART_SIZE_BYTES',
    'MULTIPART_UPLOAD_URL_EXPIRES_SECONDS',
    'MULTIPART_UPLOAD_SESSION_TTL_MS',
  ];
  const ragVariables = [
    'S3_REGION',
    'RAG_DB_POOL_MAX',
    'RAG_DB_POOL_TIMEOUT_MS',
  ];

  for (const variable of serverVariables) {
    assert.match(serverEnvExample, new RegExp(`^${variable}=`, 'm'), `${variable} missing from server/.env.example`);
    assert.match(readmeSource, new RegExp(`\\b${variable}\\b`), `${variable} missing from README.md`);
  }
  for (const variable of ragVariables) {
    assert.match(ragEnvExample, new RegExp(`^${variable}=`, 'm'), `${variable} missing from rag-service/.env.example`);
    assert.match(readmeSource, new RegExp(`\\b${variable}\\b`), `${variable} missing from README.md`);
  }

  for (const source of [rootEnvExample, serverEnvExample, ragEnvExample, readmeSource]) {
    assert.match(source, /openssl rand -hex 32/);
  }
  for (const source of [serverEnvExample, ragEnvExample, readmeSource]) {
    assert.doesNotMatch(source, /postgres:\/\/chatllm:chatllm@/);
    assert.doesNotMatch(source, /\bminioadmin\b/);
    assert.doesNotMatch(source, /\bchatllm-password\b/);
  }

  assert.match(readmeSource, /202 Accepted/);
  assert.match(readmeSource, /deletion_status/);
  assert.match(readmeSource, /reserved_bytes/);
  assert.match(readmeSource, /storage_bytes/);
  assert.match(readmeSource, /外部对象确认不存在后[^\n]*释放/);
  assert.match(readmeSource, /0025_security_sessions_rate_limits\.sql/);
  assert.match(readmeSource, /(?:备份|backup)/i);
  assert.match(readmeSource, /旧版本[^\n]*(?:不能|无法)[^\n]*(?:回滚|token)/i);
  assert.match(readmeSource, /npm run check:ops/);
  assert.match(readmeSource, /\/health\/queues/);
  assert.match(readmeSource, /OPS_RAG_TOKEN/);
});

test('buildOpsTargets includes app, RAG, and infra readiness endpoints by default', () => {
  const targets = buildOpsTargets({
    ...testOpsEnv,
    OPS_BACKEND_URL: 'http://localhost:3000',
    OPS_RAG_URL: 'http://localhost:8000',
    OPS_ELASTICSEARCH_URL: 'http://localhost:9200',
    OPS_NEO4J_URL: 'http://localhost:7474',
    OPS_MILVUS_HEALTH_URL: 'http://localhost:9091/healthz',
  }, isolatedEnvFiles);

  assert.deepEqual(targets.map((target) => target.label), [
    'backend live',
    'backend ready',
    'backend metrics',
    'backend queue health',
    'rag ready',
    'elasticsearch',
    'neo4j',
    'milvus',
  ]);
  assert.equal(targets[0].url, 'http://localhost:3000/health/live');
  assert.equal(targets[1].responseKind, 'backend-ready');
  assert.equal(targets[3].url, 'http://localhost:3000/health/queues');
  assert.equal(targets[4].url, 'http://localhost:8000/health/ready');
  assert.equal(targets[4].responseKind, 'rag-ready');
  assert.equal(targets[7].url, 'http://localhost:9091/healthz');
});

test('buildOpsTargets authenticates metrics, queue health, and RAG readiness probes', () => {
  const targets = buildOpsTargets({
    OPS_BACKEND_URL: 'http://localhost:3000',
    OPS_RAG_URL: 'http://localhost:8000',
    OPS_METRICS_TOKEN: 'metrics-token',
    OPS_RAG_TOKEN: 'rag-token-at-least-32-characters',
    OPS_SKIP_INFRA: 'true',
  }, isolatedEnvFiles);
  const metricsTarget = targets.find((target) => target.label === 'backend metrics');
  const queueTarget = targets.find((target) => target.label === 'backend queue health');
  const ragTarget = targets.find((target) => target.label === 'rag ready');

  assert.equal(metricsTarget.headers.authorization, 'Bearer metrics-token');
  assert.equal(queueTarget.headers.authorization, 'Bearer metrics-token');
  assert.equal(ragTarget.headers['X-ChatLLM-RAG-Token'], 'rag-token-at-least-32-characters');
});

test('buildOpsTargets reads RAG credentials from injected server and RAG env maps', () => {
  const fromServer = buildOpsTargets({
    OPS_BACKEND_URL: 'http://localhost:3000',
    OPS_RAG_URL: 'http://localhost:8000',
    OPS_SKIP_INFRA: 'true',
  }, {
    serverEnv: { METRICS_TOKEN: 'server-metrics-token', RAG_SERVICE_TOKEN: 'server-rag-token' },
    ragEnv: { RAG_SERVICE_TOKEN: 'rag-env-token' },
  });
  const fromRag = buildOpsTargets({
    OPS_BACKEND_URL: 'http://localhost:3000',
    OPS_RAG_URL: 'http://localhost:8000',
    OPS_SKIP_INFRA: 'true',
  }, {
    serverEnv: { METRICS_TOKEN: 'server-metrics-token' },
    ragEnv: { RAG_SERVICE_TOKEN: 'rag-env-token' },
  });

  assert.equal(
    fromServer.find((target) => target.label === 'rag ready').headers['X-ChatLLM-RAG-Token'],
    'server-rag-token',
  );
  assert.equal(
    fromRag.find((target) => target.label === 'rag ready').headers['X-ChatLLM-RAG-Token'],
    'rag-env-token',
  );
});

test('buildOpsTargets does not read env files when both operator tokens are explicit', () => {
  const forbiddenEnvFiles = {};
  Object.defineProperties(forbiddenEnvFiles, {
    serverEnv: { get: () => { throw new Error('server env file was read'); } },
    ragEnv: { get: () => { throw new Error('rag env file was read'); } },
  });

  assert.doesNotThrow(() => buildOpsTargets({
    OPS_BACKEND_URL: 'http://localhost:3000',
    OPS_RAG_URL: 'http://localhost:8000',
    OPS_METRICS_TOKEN: 'explicit-metrics-token',
    OPS_RAG_TOKEN: 'explicit-rag-token',
    OPS_SKIP_INFRA: 'true',
  }, forbiddenEnvFiles));
});

test('buildOpsTargets can skip external infrastructure checks for app-only smoke', () => {
  const targets = buildOpsTargets({
    ...testOpsEnv,
    OPS_BACKEND_URL: 'http://localhost:3000',
    OPS_RAG_URL: 'http://localhost:8000',
    OPS_SKIP_INFRA: 'true',
  }, isolatedEnvFiles);

  assert.deepEqual(targets.map((target) => target.label), [
    'backend live',
    'backend ready',
    'backend metrics',
    'backend queue health',
    'rag ready',
  ]);
});

test('runOpsChecks reports failed probes without stopping later checks', async () => {
  const calls = [];
  const fakeFetch = async (url) => ({
    calls: calls.push([url]),
    status: url.endsWith('/metrics') ? 500 : 200,
    text: async () => (url.endsWith('/metrics') ? 'oops' : '{"status":"ok"}'),
  });

  const checks = await runOpsChecks([
    { label: 'backend live', url: 'http://localhost:3000/health/live' },
    { label: 'backend metrics', url: 'http://localhost:3000/metrics' },
    { label: 'rag ready', url: 'http://localhost:8000/health/ready' },
  ], { timeoutMs: 1000 }, fakeFetch);

  assert.deepEqual(checks.map((check) => check.status), ['ok', 'error', 'ok']);
  assert.equal(hasFailedOpsChecks(checks), true);
  assert.match(checks[1].detail, /HTTP 500/);
});

test('runOpsChecks passes target headers to probes', async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    return { status: 200 };
  };

  await runOpsChecks([
    {
      label: 'backend metrics',
      url: 'http://localhost:3000/metrics',
      headers: { authorization: 'Bearer metrics-token' },
    },
  ], { timeoutMs: 1000 }, fakeFetch);

  assert.equal(requests[0].init.headers.authorization, 'Bearer metrics-token');
});

test('runOpsChecks reports only allowlisted queue health statuses', async () => {
  const checks = await runOpsChecks([
    {
      label: 'backend queue health',
      url: 'http://localhost:3000/health/queues',
      responseKind: 'queue-health',
    },
  ], { timeoutMs: 1000 }, async () => ({
    status: 503,
    json: async () => ({
      status: 'degraded',
      checks: {
        cleanup: { status: 'degraded', exhausted: 7, last_error: 'database-secret' },
        ingestion_leases: { status: 'ok', expired: 0 },
        eval_leases: { status: 'degraded', expired: 2 },
      },
    }),
  }));

  assert.equal(checks[0].status, 'error');
  assert.equal(
    checks[0].detail,
    'HTTP 503; cleanup=degraded, ingestion_leases=ok, eval_leases=degraded',
  );
  assert.doesNotMatch(checks[0].detail, /database-secret|last_error|exhausted|expired/);
});

test('runOpsChecks validates backend dependencies and reports RAG capability degradation', async () => {
  const responses = {
    'backend-ready': {
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok', rag: 'ok' },
    },
    'rag-ready': {
      status: 'ready',
      checks: { postgres: 'ok', milvus: 'ok', elasticsearch: 'ok', neo4j: 'ok' },
      capabilities: {
        status: 'degraded',
        features: {
          query_rewrite: { status: 'degraded' },
          reranker: { status: 'degraded' },
          graph_extraction: { status: 'degraded' },
          retrieval_cache: { status: 'enabled' },
          markdown_index: { status: 'degraded', stale_file_count: 4 },
        },
      },
    },
  };
  const checks = await runOpsChecks([
    { label: 'backend ready', url: 'http://localhost/backend', responseKind: 'backend-ready' },
    { label: 'rag ready', url: 'http://localhost/rag', responseKind: 'rag-ready' },
  ], { timeoutMs: 1000 }, async (_url, init) => ({
    status: 200,
    json: async () => responses[init.headers?.kind || (_url.endsWith('/backend') ? 'backend-ready' : 'rag-ready')],
  }));

  assert.deepEqual(checks.map((check) => check.status), ['ok', 'ok']);
  assert.match(checks[0].detail, /redis=ok/);
  assert.match(checks[1].detail, /capabilities=degraded/);
  assert.match(checks[1].detail, /stale_markdown_files=4/);
});

test('runOpsChecks preserves request URLs while redacting report URLs and network errors', async () => {
  const requests = [];
  const targetUrl = 'https://example.test/health?token=query-secret-value#fragment-secret-value';
  const checks = await runOpsChecks([
    { label: 'custom health', url: targetUrl },
  ], { timeoutMs: 1000 }, async (url) => {
    requests.push(url);
    throw Object.assign(new Error('exception-secret-value'), { code: 'ECONNREFUSED' });
  });

  assert.deepEqual(requests, [targetUrl]);
  assert.equal(checks[0].url, 'https://example.test/health');
  assert.deepEqual(JSON.parse(checks[0].detail), {
    name: 'Error',
    code: 'ECONNREFUSED',
  });
  assert.doesNotMatch(JSON.stringify(checks), /query-secret-value|fragment-secret-value|exception-secret-value/);
});

test('buildOpsReport renders a compact operator summary', () => {
  const report = buildOpsReport([
    { label: 'backend live', status: 'ok', detail: 'HTTP 200', durationMs: 5 },
    { label: 'backend metrics', status: 'error', detail: 'HTTP 500', durationMs: 7 },
  ]);

  assert.match(report, /Ops check completed/);
  assert.match(report, /OK backend live - HTTP 200/);
  assert.match(report, /ERROR backend metrics - HTTP 500/);
});

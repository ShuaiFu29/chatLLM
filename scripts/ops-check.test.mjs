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

test('docker compose binds every published infrastructure port to loopback by default', () => {
  const expectedPorts = [
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
    .map((match) => match[1])
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

test('buildOpsTargets includes app, RAG, and infra readiness endpoints by default', () => {
  const targets = buildOpsTargets({
    OPS_BACKEND_URL: 'http://localhost:3000',
    OPS_RAG_URL: 'http://localhost:8000',
    OPS_ELASTICSEARCH_URL: 'http://localhost:9200',
    OPS_NEO4J_URL: 'http://localhost:7474',
    OPS_MILVUS_HEALTH_URL: 'http://localhost:9091/healthz',
  });

  assert.deepEqual(targets.map((target) => target.label), [
    'backend live',
    'backend ready',
    'backend metrics',
    'rag ready',
    'elasticsearch',
    'neo4j',
    'milvus',
  ]);
  assert.equal(targets[0].url, 'http://localhost:3000/health/live');
  assert.equal(targets[3].url, 'http://localhost:8000/health/ready');
  assert.equal(targets[6].url, 'http://localhost:9091/healthz');
});

test('buildOpsTargets attaches a metrics bearer token when configured', () => {
  const targets = buildOpsTargets({
    OPS_BACKEND_URL: 'http://localhost:3000',
    OPS_RAG_URL: 'http://localhost:8000',
    OPS_METRICS_TOKEN: 'metrics-token',
    OPS_SKIP_INFRA: 'true',
  });
  const metricsTarget = targets.find((target) => target.label === 'backend metrics');

  assert.equal(metricsTarget.headers.authorization, 'Bearer metrics-token');
});

test('buildOpsTargets can skip external infrastructure checks for app-only smoke', () => {
  const targets = buildOpsTargets({
    OPS_BACKEND_URL: 'http://localhost:3000',
    OPS_RAG_URL: 'http://localhost:8000',
    OPS_SKIP_INFRA: 'true',
  });

  assert.deepEqual(targets.map((target) => target.label), [
    'backend live',
    'backend ready',
    'backend metrics',
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

test('buildOpsReport renders a compact operator summary', () => {
  const report = buildOpsReport([
    { label: 'backend live', status: 'ok', detail: 'HTTP 200', durationMs: 5 },
    { label: 'backend metrics', status: 'error', detail: 'HTTP 500', durationMs: 7 },
  ]);

  assert.match(report, /Ops check completed/);
  assert.match(report, /OK backend live - HTTP 200/);
  assert.match(report, /ERROR backend metrics - HTTP 500/);
});

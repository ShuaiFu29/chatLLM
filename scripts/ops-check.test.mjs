import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildOpsReport,
  buildOpsTargets,
  hasFailedOpsChecks,
  runOpsChecks,
} from './ops-check.mjs';

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
  const fakeFetch = async (url) => ({
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

test('buildOpsReport renders a compact operator summary', () => {
  const report = buildOpsReport([
    { label: 'backend live', status: 'ok', detail: 'HTTP 200', durationMs: 5 },
    { label: 'backend metrics', status: 'error', detail: 'HTTP 500', durationMs: 7 },
  ]);

  assert.match(report, /Ops check completed/);
  assert.match(report, /OK backend live - HTTP 200/);
  assert.match(report, /ERROR backend metrics - HTTP 500/);
});

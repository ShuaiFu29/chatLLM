import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { acquirePostgresIntegrationLock } from './postgres-integration-lock.mjs';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL
    || 'postgres://queue-health-test:queue-health-test@localhost:5432/queue-health-test',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'queue-health-test-access-key',
  S3_SECRET_KEY: 'queue-health-test-secret-key',
  JWT_SECRET: 'queue-health-test-jwt-secret-at-least-32-characters',
  RAG_SERVICE_TOKEN: 'queue-health-test-rag-token-at-least-32-characters',
  METRICS_TOKEN: 'queue-health-test-metrics-token-at-least-32-characters',
});

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const health = require(path.join(serverRoot, 'dist', 'lib', 'health.js'));
const queueHealthDistPath = path.join(serverRoot, 'dist', 'lib', 'queueHealth.js');
const queueHealth = existsSync(queueHealthDistPath) ? require(queueHealthDistPath) : null;
const { OperationsController } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'operations',
  'operations.controller.js',
));
const queueHealthSourcePath = path.join(serverRoot, 'src', 'lib', 'queueHealth.ts');
const queueHealthSource = existsSync(queueHealthSourcePath)
  ? readFileSync(queueHealthSourcePath, 'utf8')
  : '';
const operationsSource = readFileSync(
  path.join(serverRoot, 'src', 'modules', 'operations', 'operations.controller.ts'),
  'utf8',
);
const integrationEnabled = process.env.QUEUE_HEALTH_INTEGRATION === '1'
  && Boolean(process.env.TEST_DATABASE_URL);

const metricsAuthorization = `Bearer ${process.env.METRICS_TOKEN}`;

test('queue health classifies pending work as healthy and exhausted or stale leases as degraded', () => {
  assert.ok(queueHealth, 'dist/lib/queueHealth.js must exist');

  assert.deepEqual(queueHealth.classifyQueueHealth({
    cleanup_pending: 4,
    cleanup_exhausted: 0,
    cleanup_expired_leases: 0,
    ingestion_expired_leases: 0,
    eval_expired_leases: 0,
  }), {
    status: 'ok',
    checks: {
      cleanup: { status: 'ok', pending: 4, exhausted: 0, expired_leases: 0 },
      ingestion_leases: { status: 'ok', expired: 0 },
      eval_leases: { status: 'ok', expired: 0 },
    },
  });

  assert.equal(queueHealth.classifyQueueHealth({
    cleanup_pending: 1,
    cleanup_exhausted: 2,
    cleanup_expired_leases: 1,
    ingestion_expired_leases: 3,
    eval_expired_leases: 4,
  }).status, 'degraded');
});

test('OperationsController returns 503 for degraded queues and stable public errors', async () => {
  assert.ok(queueHealth, 'dist/lib/queueHealth.js must exist');
  const controller = new OperationsController();
  const originalReadQueueHealthCounts = queueHealth.readQueueHealthCounts;
  queueHealth.readQueueHealthCounts = async () => ({
    cleanup_pending: 1,
    cleanup_exhausted: 1,
    cleanup_expired_leases: 0,
    ingestion_expired_leases: 0,
    eval_expired_leases: 0,
  });
  const degradedResponse = await controller.queues(
    metricsAuthorization,
    undefined,
    'request-queue-health',
  );

  assert.equal(degradedResponse.options.statusCode, 503);
  assert.equal(degradedResponse.body.status, 'degraded');
  assert.equal(degradedResponse.body.checks.cleanup.status, 'degraded');

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    queueHealth.readQueueHealthCounts = async () => {
      throw Object.assign(new Error('postgres-password-leak'), { code: 'QUERY_FAILED' });
    };
    const errorResponse = await controller.queues(
      undefined,
      process.env.METRICS_TOKEN,
      'request-queue-health',
    );

    assert.equal(errorResponse.options.statusCode, 503);
    assert.deepEqual(errorResponse.body, {
      status: 'unavailable',
      checks: {
        cleanup: { status: 'error' },
        ingestion_leases: { status: 'error' },
        eval_leases: { status: 'error' },
      },
      requestId: 'request-queue-health',
    });
    assert.doesNotMatch(JSON.stringify({ body: errorResponse.body, warnings }), /postgres-password-leak/);
  } finally {
    queueHealth.readQueueHealthCounts = originalReadQueueHealthCounts;
    console.warn = originalWarn;
  }
});

test('OperationsController preserves ready probe 200 and 503 contracts', async () => {
  const controller = new OperationsController();
  const originalReadReadyHealth = health.readReadyHealth;

  try {
    health.readReadyHealth = async (_dependencies, requestId) => ({
      statusCode: 200,
      body: { status: 'ready', checks: { postgres: 'ok' }, requestId },
    });
    const ready = await controller.ready('request-ready');
    assert.equal(ready.options.statusCode, 200);
    assert.deepEqual(ready.body, {
      status: 'ready',
      checks: { postgres: 'ok' },
      requestId: 'request-ready',
    });

    health.readReadyHealth = async () => ({
      statusCode: 503,
      body: { status: 'not_ready', checks: { postgres: 'error' } },
    });
    const unavailable = await controller.ready('request-unavailable');
    assert.equal(unavailable.options.statusCode, 503);
    assert.deepEqual(unavailable.body, {
      status: 'not_ready',
      checks: { postgres: 'error' },
    });
  } finally {
    health.readReadyHealth = originalReadReadyHealth;
  }
});

test('OperationsController preserves healthy queue 200 contract', async () => {
  const originalReadQueueHealthCounts = queueHealth.readQueueHealthCounts;

  try {
    queueHealth.readQueueHealthCounts = async () => ({
      cleanup_pending: 3,
      cleanup_exhausted: 0,
      cleanup_expired_leases: 0,
      ingestion_expired_leases: 0,
      eval_expired_leases: 0,
    });
    const response = await new OperationsController().queues(
      metricsAuthorization,
      undefined,
      'request-healthy-queues',
    );

    assert.equal(response.options.statusCode, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.body.checks.cleanup.pending, 3);
  } finally {
    queueHealth.readQueueHealthCounts = originalReadQueueHealthCounts;
  }
});

test('OperationsController rejects missing metrics credentials without native replies', async () => {
  const controller = new OperationsController();

  const queueResponse = await controller.queues(undefined, undefined, 'request-unauthorized');
  const metricsResponse = controller.metrics('Bearer incorrect-token', undefined);

  for (const response of [queueResponse, metricsResponse]) {
    assert.equal(response.options.statusCode, 401);
    assert.deepEqual(response.body, { error: 'Unauthorized' });
  }
  assert.doesNotMatch(operationsSource, /@(Req|Res)\s*\(/);
  assert.doesNotMatch(operationsSource, /\bApp(?:Request|Reply)\b/);
});

test('OperationsController fails closed with 503 when metrics token is not configured', () => {
  const { serverEnv } = require(path.join(serverRoot, 'dist', 'lib', 'env.js'));
  const originalMetricsToken = serverEnv.METRICS_TOKEN;

  try {
    serverEnv.METRICS_TOKEN = '';
    const response = new OperationsController().metrics(undefined, undefined);
    assert.equal(response.options.statusCode, 503);
    assert.deepEqual(response.body, { error: 'Metrics token is not configured' });
  } finally {
    serverEnv.METRICS_TOKEN = originalMetricsToken;
  }
});

test('OperationsController preserves Prometheus text content type', () => {
  const response = new OperationsController().metrics(metricsAuthorization, undefined);

  assert.equal(response.options.statusCode, undefined);
  assert.equal(response.options.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(response.body, /chatllm_http_requests_total/);
});

test('queue health query checks cleanup exhaustion and only active expired leases', () => {
  const exhaustedCleanupPredicate = queueHealthSource.match(
    /from artifact_cleanup_jobs\s+where ([\s\S]*?)\) as cleanup_exhausted/i,
  )?.[1] || '';

  assert.match(queueHealthSource, /from artifact_cleanup_jobs/i);
  assert.match(exhaustedCleanupPredicate, /status\s*=\s*'failed'/i);
  assert.match(exhaustedCleanupPredicate, /attempts\s*>=\s*max_attempts/i);
  assert.match(queueHealthSource, /status\s*=\s*'processing'[\s\S]*lease_expires_at\s*<=\s*now\(\)/i);
  assert.match(queueHealthSource, /from file_ingestion_jobs[\s\S]*status\s+in\s*\('queued',\s*'processing'\)[\s\S]*lease_expires_at\s*<=\s*now\(\)/i);
  assert.match(queueHealthSource, /from rag_eval_runs[\s\S]*status\s*=\s*'running'[\s\S]*lease_expires_at\s*<=\s*now\(\)/i);
  assert.match(operationsSource, /@Get\('health\/queues'\)/);
  assert.match(operationsSource, /classifyQueueHealth\(await readQueueHealthCounts\(\)\)/);
});

test('PostgreSQL executes the queue health snapshot query against the migrated schema', {
  skip: integrationEnabled ? false : 'set QUEUE_HEALTH_INTEGRATION=1 and TEST_DATABASE_URL to run',
}, async () => {
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  const db = await import(pathToFileURL(path.join(serverRoot, 'dist', 'lib', 'db.js')).href);
  const migrations = await import(pathToFileURL(path.join(serverRoot, 'dist', 'lib', 'migrations.js')).href);
  let releaseIntegrationLock = async () => undefined;

  try {
    releaseIntegrationLock = await acquirePostgresIntegrationLock(db.pool);
    await migrations.runMigrations();
    const counts = await queueHealth.readQueueHealthCounts();

    assert.deepEqual(Object.keys(counts).sort(), [
      'cleanup_exhausted',
      'cleanup_expired_leases',
      'cleanup_pending',
      'eval_expired_leases',
      'ingestion_expired_leases',
    ]);
    for (const count of Object.values(counts)) {
      assert.equal(Number.isSafeInteger(count), true);
      assert.ok(count >= 0);
    }
  } finally {
    await releaseIntegrationLock();
    await db.closeDatabasePool();
  }
});

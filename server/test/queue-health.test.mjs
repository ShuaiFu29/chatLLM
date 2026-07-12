import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
});

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queueHealthDistPath = path.join(serverRoot, 'dist', 'lib', 'queueHealth.js');
const queueHealth = existsSync(queueHealthDistPath)
  ? await import(pathToFileURL(queueHealthDistPath).href)
  : null;
const queueHealthSourcePath = path.join(serverRoot, 'src', 'lib', 'queueHealth.ts');
const queueHealthSource = existsSync(queueHealthSourcePath)
  ? readFileSync(queueHealthSourcePath, 'utf8')
  : '';
const indexSource = readFileSync(path.join(serverRoot, 'src', 'index.ts'), 'utf8');
const integrationEnabled = process.env.QUEUE_HEALTH_INTEGRATION === '1'
  && Boolean(process.env.TEST_DATABASE_URL);

const createResponse = () => ({
  locals: { requestId: 'request-queue-health' },
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

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

test('queue health handler returns 503 for degraded queues and stable public errors', async () => {
  assert.ok(queueHealth, 'dist/lib/queueHealth.js must exist');
  const degradedResponse = createResponse();
  await queueHealth.createQueueHealthHandler(async () => ({
    cleanup_pending: 1,
    cleanup_exhausted: 1,
    cleanup_expired_leases: 0,
    ingestion_expired_leases: 0,
    eval_expired_leases: 0,
  }))({}, degradedResponse);

  assert.equal(degradedResponse.statusCode, 503);
  assert.equal(degradedResponse.body.status, 'degraded');
  assert.equal(degradedResponse.body.checks.cleanup.status, 'degraded');

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const errorResponse = createResponse();
    await queueHealth.createQueueHealthHandler(async () => {
      throw Object.assign(new Error('postgres-password-leak'), { code: 'QUERY_FAILED' });
    })({}, errorResponse);

    assert.equal(errorResponse.statusCode, 503);
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
    console.warn = originalWarn;
  }
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
  assert.match(indexSource, /app\.get\('\/health\/queues', metricsAuthMiddleware, queueHealthHandler\)/);
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

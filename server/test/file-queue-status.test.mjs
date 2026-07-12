import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(readSource(relativePath));

test('usage API exposes per-user file queue state for document processing traceability', () => {
  const routeSource = readSource('src/routes/usage.ts');
  const controllerSource = readSource('src/controllers/usage.ts');
  const repositorySource = readSource('src/repositories/usage.ts');
  const migrationSource = readSource('migrations/0021_file_ingestion_jobs.sql');

  assert.match(routeSource, /getUsageFileQueue/);
  assert.match(routeSource, /router\.get\('\/file-queue', requireAuth, getUsageFileQueue\)/);

  assert.match(controllerSource, /getUsageFileQueue/);
  assert.match(controllerSource, /getFileQueueSummaryForUser\(req\.user\.id, fileLimit\)/);
  assert.match(controllerSource, /DEFAULT_USAGE_FILE_LIMIT/);
  assert.match(controllerSource, /MAX_USAGE_FILE_LIMIT/);

  assert.match(repositorySource, /getFileQueueSummaryForUser/);
  assert.match(repositorySource, /count\(\*\) filter \(where status = 'pending'\)/i);
  assert.match(repositorySource, /count\(\*\) filter \(where status = 'processing'\)/i);
  assert.match(repositorySource, /count\(\*\) filter \(where status = 'failed'\)/i);
  assert.match(repositorySource, /attempts/);
  assert.match(repositorySource, /max_attempts/);
  assert.match(repositorySource, /next_attempt_at/);
  assert.match(repositorySource, /error_message/);
  assert.match(repositorySource, /left join file_ingestion_jobs/i);
  assert.match(repositorySource, /ingestion_stage/);
  assert.match(repositorySource, /indexed_chunks/);
  assert.match(repositorySource, /vector_batches/);
  assert.match(repositorySource, /heartbeat_at/);
  assert.match(repositorySource, /order by greatest\(files\.updated_at, coalesce\(file_ingestion_jobs\.updated_at, files\.updated_at\)\) desc\s+limit \$2/i);

  assert.match(migrationSource, /create table if not exists file_ingestion_jobs/i);
  assert.match(migrationSource, /checkpoint jsonb not null default '\{\}'::jsonb/i);
  assert.match(migrationSource, /file_ingestion_jobs_user_status_idx/i);
  assert.match(migrationSource, /file_ingestion_jobs_heartbeat_idx/i);
});

test('usage page renders document processing queue state with i18n coverage', () => {
  const usagePageSource = readSource('../client/src/pages/Usage.tsx');
  const en = readJson('../client/src/locales/en.json');
  const zh = readJson('../client/src/locales/zh.json');

  assert.match(usagePageSource, /UsageFileQueueResponse/);
  assert.match(usagePageSource, /fetchFileQueue/);
  assert.match(usagePageSource, /\/usage\/file-queue/);
  assert.match(usagePageSource, /fileQueue\?\.summary\.processing/);
  assert.match(usagePageSource, /isFileJobsModalOpen/);
  assert.match(usagePageSource, /fileQueue\.files\.map/);
  assert.match(usagePageSource, /ingestion_stage/);
  assert.match(usagePageSource, /usage\.ingestionStage/);
  assert.match(usagePageSource, /usage\.indexedChunks/);
  assert.match(usagePageSource, /usage\.heartbeatAt/);

  for (const key of [
    'documentProcessing',
    'documentProcessingHint',
    'pendingDocuments',
    'processingDocuments',
    'retryableDocuments',
    'recentDocumentJobs',
    'viewRecentDocumentJobs',
    'attempts',
    'nextRetry',
    'queueLoadFailed',
    'ingestionStage',
    'indexedChunks',
    'vectorBatches',
    'keywordBatches',
    'graphBatches',
    'heartbeatAt',
  ]) {
    assert.equal(typeof en.usage[key], 'string', `missing English usage.${key}`);
    assert.equal(typeof zh.usage[key], 'string', `missing Chinese usage.${key}`);
  }
});

test('file queue waits for durable synchronous RAG ingestion instead of fire-and-forget background tasks', () => {
  const queueSource = readSource('src/services/fileQueue.ts');
  const ragClientSource = readSource('src/lib/ragClient.ts');
  const envSource = readSource('src/lib/env.ts');
  const envExampleSource = readSource('.env.example');

  assert.match(queueSource, /ingestRagFile/);
  assert.match(ragClientSource, /\/ingest-sync/);
  assert.doesNotMatch(ragClientSource, /\/ingest['"`]/);
  assert.match(ragClientSource, /FILE_QUEUE_INGEST_TIMEOUT_MS/);
  assert.match(envSource, /DEFAULT_FILE_QUEUE_INGEST_TIMEOUT_MS = 5 \* 60 \* 1000/);
  assert.match(envExampleSource, /FILE_QUEUE_INGEST_TIMEOUT_MS=300000/);
});

test('ingestion attempts have durable ids, renewable leases, and lease-scoped repository transitions', () => {
  const migrationSource = readSource('migrations/0026_file_lifecycle_cleanup.sql');
  const repositorySource = readSource('src/repositories/files.ts');
  const queueSource = readSource('src/services/fileQueue.ts');
  const ragClientSource = readSource('src/lib/ragClient.ts');

  assert.match(migrationSource, /alter table file_ingestion_jobs[\s\S]*attempt_id uuid/i);
  assert.match(migrationSource, /lease_token uuid/i);
  assert.match(migrationSource, /lease_expires_at timestamptz/i);
  assert.match(migrationSource, /file_ingestion_jobs_lease_expiry_idx/i);
  assert.match(repositorySource, /insert into file_ingestion_jobs/i);
  assert.match(repositorySource, /attempt_id = excluded\.attempt_id/i);
  assert.match(repositorySource, /lease_token = excluded\.lease_token/i);
  assert.match(repositorySource, /export const renewFileIngestionLease/);
  assert.match(repositorySource, /export const reconcileFileIngestionAttempt/);
  assert.match(repositorySource, /attempt_id = \$[0-9]+[\s\S]*lease_token = \$[0-9]+/i);
  assert.match(queueSource, /attemptId:\s*claim\.attemptId/);
  assert.match(queueSource, /leaseToken:\s*claim\.leaseToken/);
  assert.match(queueSource, /reconcileFileIngestionJobs/);
  assert.doesNotMatch(queueSource, /markFileAttemptFailed/);
  assert.match(ragClientSource, /\/ingest-sync/);
});

test('HTTP timeout leaves a still-leased ingestion attempt processing', async () => {
  const queue = require(path.join(serverRoot, 'dist', 'services', 'fileQueue.js'));
  assert.equal(typeof queue.executeFileIngestionAttempt, 'function');

  const claim = {
    file: { id: 'file-1' },
    attemptId: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
  };
  const payloads = [];
  let stoppedHeartbeat = false;
  const result = await queue.executeFileIngestionAttempt(claim, {
    ingestFile: async (input) => {
      payloads.push(input);
      throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    },
    startHeartbeat: () => () => { stoppedHeartbeat = true; },
    reconcileAttempt: async () => ({ state: 'active' }),
    warn: () => undefined,
  });

  assert.deepEqual(payloads, [{
    fileId: 'file-1',
    attemptId: claim.attemptId,
    leaseToken: claim.leaseToken,
  }]);
  assert.deepEqual(result, { state: 'active' });
  assert.equal(stoppedHeartbeat, true);
});

test('reconciliation rejects a late terminal write from a replaced ingestion lease', async () => {
  const files = require(path.join(serverRoot, 'dist', 'repositories', 'files.js'));
  assert.equal(typeof files.reconcileFileIngestionAttempt, 'function');

  const queries = [];
  const runInTransaction = async (callback) => callback({
    query: async (sql) => {
      queries.push(sql);
      if (/from files/i.test(sql)) {
        return { rows: [{ id: 'file-1', status: 'processing', attempts: 1, max_attempts: 3 }] };
      }
      if (/from file_ingestion_jobs/i.test(sql)) {
        return { rows: [{
          file_id: 'file-1',
          status: 'completed',
          attempt_id: '33333333-3333-4333-8333-333333333333',
          lease_token: '44444444-4444-4444-8444-444444444444',
          lease_active: false,
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const result = await files.reconcileFileIngestionAttempt({
    file: { id: 'file-1', attempts: 1, max_attempts: 3 },
    attemptId: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
  }, { runInTransaction });

  assert.deepEqual(result, { state: 'superseded' });
  assert.equal(queries.some((sql) => /update files/i.test(sql)), false);
});

test('Express alone publishes completed file state from the current ingestion job', async () => {
  const files = require(path.join(serverRoot, 'dist', 'repositories', 'files.js'));
  assert.equal(typeof files.reconcileFileIngestionAttempt, 'function');

  const updates = [];
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const leaseToken = '22222222-2222-4222-8222-222222222222';
  const runInTransaction = async (callback) => callback({
    query: async (sql) => {
      if (/from files/i.test(sql)) {
        return { rows: [{ id: 'file-1', status: 'processing', attempts: 1, max_attempts: 3 }] };
      }
      if (/from file_ingestion_jobs/i.test(sql)) {
        return { rows: [{
          file_id: 'file-1',
          status: 'completed',
          attempt_id: attemptId,
          lease_token: leaseToken,
          lease_active: false,
        }] };
      }
      if (/update files/i.test(sql)) {
        updates.push(sql);
        return { rows: [{ id: 'file-1', status: 'completed' }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const result = await files.reconcileFileIngestionAttempt({
    file: { id: 'file-1', attempts: 1, max_attempts: 3 },
    attemptId,
    leaseToken,
  }, { runInTransaction });

  assert.equal(result.state, 'completed');
  assert.equal(updates.length, 1);
  assert.match(updates[0], /set status = 'completed'/i);
  assert.match(updates[0], /status = 'processing'/i);
});

test('lease renewal cannot revive an expired or replaced ingestion attempt', async () => {
  const files = require(path.join(serverRoot, 'dist', 'repositories', 'files.js'));
  assert.equal(typeof files.renewFileIngestionLease, 'function');

  const calls = [];
  const runQuery = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  };
  const claim = {
    file: { id: 'file-1' },
    attemptId: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
  };

  const renewed = await files.renewFileIngestionLease(claim, {
    leaseDurationMs: 60_000,
    runQuery,
  });

  assert.equal(renewed, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /attempt_id = \$2/i);
  assert.match(calls[0].sql, /lease_token = \$3/i);
  assert.match(calls[0].sql, /status = 'processing'/i);
  assert.match(calls[0].sql, /lease_expires_at > now\(\)/i);
  assert.deepEqual(calls[0].params.slice(0, 3), [
    'file-1',
    claim.attemptId,
    claim.leaseToken,
  ]);
});

test('reconciliation never downgrades an already completed file', async () => {
  const files = require(path.join(serverRoot, 'dist', 'repositories', 'files.js'));
  const updates = [];
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const leaseToken = '22222222-2222-4222-8222-222222222222';
  const runInTransaction = async (callback) => callback({
    query: async (sql) => {
      if (/from files/i.test(sql)) {
        return { rows: [{ id: 'file-1', status: 'completed', attempts: 1, max_attempts: 3 }] };
      }
      if (/from file_ingestion_jobs/i.test(sql)) {
        return { rows: [{
          file_id: 'file-1',
          status: 'failed',
          attempt_id: attemptId,
          lease_token: leaseToken,
          lease_active: false,
          error_message: 'late failure',
        }] };
      }
      if (/update files/i.test(sql)) {
        updates.push(sql);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const result = await files.reconcileFileIngestionAttempt({
    file: { id: 'file-1', attempts: 1, max_attempts: 3 },
    attemptId,
    leaseToken,
  }, { runInTransaction });

  assert.deepEqual(result, { state: 'completed' });
  assert.equal(updates.length, 0);
});

test('the queue stops claiming more files while any timed-out attempt remains active', () => {
  const queue = require(path.join(serverRoot, 'dist', 'services', 'fileQueue.js'));
  assert.equal(typeof queue.shouldContinueFileQueueBatch, 'function');

  assert.equal(queue.shouldContinueFileQueueBatch(2, 2, [
    { state: 'completed' },
    { state: 'failed' },
  ]), true);
  assert.equal(queue.shouldContinueFileQueueBatch(2, 2, [
    { state: 'completed' },
    { state: 'active' },
  ]), false);
  assert.equal(queue.shouldContinueFileQueueBatch(1, 2, [
    { state: 'completed' },
  ]), false);
});

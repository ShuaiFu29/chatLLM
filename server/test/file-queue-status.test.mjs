import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

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
  const envSource = readSource('src/lib/env.ts');
  const envExampleSource = readSource('.env.example');

  assert.match(queueSource, /\/ingest-sync/);
  assert.doesNotMatch(queueSource, /\/ingest['"`]/);
  assert.match(queueSource, /FILE_QUEUE_INGEST_TIMEOUT_MS/);
  assert.match(envSource, /DEFAULT_FILE_QUEUE_INGEST_TIMEOUT_MS = 5 \* 60 \* 1000/);
  assert.match(envExampleSource, /FILE_QUEUE_INGEST_TIMEOUT_MS=300000/);
});

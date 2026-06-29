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
  assert.match(repositorySource, /order by updated_at desc\s+limit \$2/i);
});

test('usage page renders document processing queue state with i18n coverage', () => {
  const usagePageSource = readSource('../client/src/pages/Usage.tsx');
  const en = readJson('../client/src/locales/en.json');
  const zh = readJson('../client/src/locales/zh.json');

  assert.match(usagePageSource, /UsageFileQueueResponse/);
  assert.match(usagePageSource, /fetchFileQueue/);
  assert.match(usagePageSource, /\/usage\/file-queue/);
  assert.match(usagePageSource, /fileQueue\?\.summary\.processing/);
  assert.match(usagePageSource, /fileQueue\?\.files\.map/);

  for (const key of [
    'documentProcessing',
    'documentProcessingHint',
    'pendingDocuments',
    'processingDocuments',
    'retryableDocuments',
    'recentDocumentJobs',
    'attempts',
    'nextRetry',
    'queueLoadFailed',
  ]) {
    assert.equal(typeof en.usage[key], 'string', `missing English usage.${key}`);
    assert.equal(typeof zh.usage[key], 'string', `missing Chinese usage.${key}`);
  }
});

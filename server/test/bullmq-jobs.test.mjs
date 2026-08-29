import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

test('BullMQ wake-up jobs use deterministic ids and minimal database-record payloads', () => {
  const { buildFileIngestionQueueJob } = require(path.join(serverRoot, 'dist', 'services', 'fileQueue.js'));
  const { buildRagEvalQueueJob } = require(path.join(serverRoot, 'dist', 'services', 'ragEvalQueue.js'));
  const { buildArtifactCleanupQueueJob } = require(path.join(serverRoot, 'dist', 'services', 'cleanupQueue.js'));
  const { buildAgentRecoveryQueueJob } = require(path.join(
    serverRoot,
    'dist',
    'services',
    'agentRecoveryQueue.js',
  ));
  const { buildAgentMemoryEmbeddingQueueJob } = require(path.join(
    serverRoot,
    'dist',
    'services',
    'agentMemoryEmbeddingQueue.js',
  ));

  const id = '11111111-1111-4111-8111-111111111111';
  const cases = [
    [buildFileIngestionQueueJob(id), { fileId: id }, `file-${id}`],
    [buildRagEvalQueueJob(id), { runId: id }, `eval-${id}`],
    [buildArtifactCleanupQueueJob(id), { cleanupJobId: id }, `cleanup-${id}`],
    [buildAgentRecoveryQueueJob(id), { workItemId: id }, `agent-recovery-${id}`],
    [
      buildAgentMemoryEmbeddingQueueJob(id),
      { memoryId: id },
      `agent-memory-embedding-${id}`,
    ],
  ];

  for (const [job, payload, jobId] of cases) {
    assert.deepEqual(job.data, payload);
    assert.equal(job.opts.jobId, jobId);
    assert.equal(job.opts.attempts, 1, 'PostgreSQL owns the business retry budget');
    assert.equal(job.opts.removeOnComplete, true);
    assert.equal(job.opts.removeOnFail, true);
  }
});

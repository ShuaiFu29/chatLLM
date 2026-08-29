import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const {
  buildAgentMemoryEmbeddingQueueJob,
  dispatchAgentMemoryEmbeddingJobs,
  executeAgentMemoryEmbedding,
} = require(path.join(
  serverRoot,
  'dist',
  'services',
  'agentMemoryEmbeddingQueue.js',
));

const buildClaim = (overrides = {}) => ({
  memory_id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  status: 'running',
  attempt_count: 1,
  next_attempt_at: new Date().toISOString(),
  worker_id: 'worker-a',
  lease_token: '33333333-3333-4333-8333-333333333333',
  lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
  last_error_code: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  completed_at: null,
  content: 'The user prefers concise Chinese answers.',
  scope: 'user',
  ...overrides,
});

test('Memory embedding dispatcher reconstructs minimal deterministic BullMQ wake-ups from PostgreSQL', async () => {
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const batches = [];
  const events = [];
  let observedLimit = null;
  const dispatched = await dispatchAgentMemoryEmbeddingJobs(
    { addBulk: async (jobs) => batches.push(jobs) },
    17,
    {
      reconcile: async () => events.push('reconciled'),
      listIds: async (limit) => {
        events.push('listed');
        observedLimit = limit;
        return ids;
      },
    },
  );

  assert.deepEqual(events, ['reconciled', 'listed']);
  assert.equal(observedLimit, 17);
  assert.deepEqual(dispatched, ids);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], ids.map(buildAgentMemoryEmbeddingQueueJob));
  for (const job of batches[0]) {
    assert.deepEqual(Object.keys(job.data), ['memoryId']);
    assert.equal('content' in job.data, false, 'Memory content must remain in PostgreSQL');
  }
});

test('successful asynchronous embedding writes exactly one fenced vector', async () => {
  const claim = buildClaim();
  const completions = [];
  const failures = [];
  const result = await executeAgentMemoryEmbedding(claim, {
    embed: async (texts, signal) => {
      assert.deepEqual(texts, [claim.content]);
      assert.equal(signal.aborted, false);
      return { embeddings: [[0.25, 0.75]], model: 'embedding-model-v1' };
    },
    complete: async (input) => {
      completions.push(input);
      return true;
    },
    fail: async (input) => failures.push(input),
    renew: async () => {
      throw new Error('fast completion must not need a heartbeat');
    },
    timeoutMs: 1_000,
    leaseDurationMs: 4_000,
    warn: () => undefined,
  });

  assert.equal(result, true);
  assert.equal(failures.length, 0);
  assert.deepEqual(completions, [{
    memoryId: claim.memory_id,
    userId: claim.user_id,
    workerId: claim.worker_id,
    leaseToken: claim.lease_token,
    embedding: { vector: [0.25, 0.75], model: 'embedding-model-v1' },
  }]);
});

test('provider timeout becomes a durable retry without waiting for a non-cooperative provider', async () => {
  const claim = buildClaim();
  const failures = [];
  let completionCalls = 0;
  const result = await executeAgentMemoryEmbedding(claim, {
    embed: async () => new Promise((resolve) => {
      setTimeout(() => resolve({ embeddings: [[1, 0]], model: 'late-model' }), 50);
    }),
    complete: async () => {
      completionCalls += 1;
      return true;
    },
    fail: async (input) => {
      failures.push(input);
      return { status: 'queued' };
    },
    renew: async () => new Date(Date.now() + 4_000).toISOString(),
    timeoutMs: 10,
    leaseDurationMs: 4_000,
    maxAttempts: 5,
    retryBaseDelayMs: 5_000,
    warn: () => undefined,
  });

  assert.equal(result, false);
  assert.equal(completionCalls, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorCode, 'embedding_timeout');
  assert.equal(failures[0].maxAttempts, 5);
  assert.equal(failures[0].retryBaseDelayMs, 5_000);
});

test('lost lease aborts provider wait and never exposes a vector through completion', async () => {
  const claim = buildClaim();
  const failures = [];
  let completionCalls = 0;
  let renewalCalls = 0;
  const result = await executeAgentMemoryEmbedding(claim, {
    embed: async () => new Promise((resolve) => {
      setTimeout(() => resolve({ embeddings: [[1, 0]], model: 'late-model' }), 200);
    }),
    complete: async () => {
      completionCalls += 1;
      return true;
    },
    fail: async (input) => {
      failures.push(input);
      return null;
    },
    renew: async () => {
      renewalCalls += 1;
      return null;
    },
    timeoutMs: 1_000,
    leaseDurationMs: 400,
    warn: () => undefined,
  });

  assert.equal(result, false);
  assert.equal(renewalCalls, 1);
  assert.equal(completionCalls, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorCode, 'embedding_lease_lost');
});

test('a fenced completion rejection is terminal for that worker and is not reclassified as provider failure', async () => {
  const claim = buildClaim();
  let failureCalls = 0;
  const result = await executeAgentMemoryEmbedding(claim, {
    embed: async () => ({ embeddings: [[1, 0]], model: 'embedding-model-v1' }),
    complete: async () => false,
    fail: async () => {
      failureCalls += 1;
      return null;
    },
    renew: async () => new Date(Date.now() + 4_000).toISOString(),
    timeoutMs: 1_000,
    leaseDurationMs: 4_000,
    warn: () => undefined,
  });

  assert.equal(result, false);
  assert.equal(failureCalls, 0);
});

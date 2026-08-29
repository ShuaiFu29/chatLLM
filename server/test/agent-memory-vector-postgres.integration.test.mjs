import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchmark = require(path.join(
  serverRoot,
  'dist/evals/agent-memory-vector-benchmark.js',
));

test('deterministic vector corpus is reproducible and normalized', () => {
  const first = benchmark.createDeterministicVectorCorpus({
    corpusSize: 100,
    dimension: 8,
    queryCount: 3,
  });
  const replay = benchmark.createDeterministicVectorCorpus({
    corpusSize: 100,
    dimension: 8,
    queryCount: 3,
  });
  assert.deepEqual(first, replay);
  assert.equal(first.corpus.length, 100);
  assert.equal(first.queries.length, 3);
  for (const item of [...first.corpus.slice(0, 3).map((entry) => entry.vector), ...first.queries]) {
    const magnitude = Math.sqrt(item.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(magnitude - 1) < 1e-10);
  }
});

test('pgvector exact scan and HNSW are compared against the same application gold ranking', {
  skip: process.env.AGENT_MEMORY_VECTOR_BENCH !== '1'
    || !process.env.TEST_DATABASE_URL
    ? 'set AGENT_MEMORY_VECTOR_BENCH=1 and TEST_DATABASE_URL to run'
    : false,
}, async () => {
  const report = await benchmark.runAgentMemoryVectorBenchmark({
    connectionString: process.env.TEST_DATABASE_URL,
    corpusSize: 5_000,
    dimension: 64,
    queryCount: 40,
    topK: 10,
    hnswEfSearch: 100,
  });
  assert.equal(report.exactSqlMatchesApplication, true);
  assert.ok(report.hnswRecallAtK >= 0.95, JSON.stringify(report));
  assert.ok(report.hnswMeanReciprocalRank >= 0.95, JSON.stringify(report));
  assert.equal(report.latencyScope, 'single_client_local_round_trip');
});


import { performance } from 'node:perf_hooks';
import { Pool, type PoolClient } from 'pg';

export const AGENT_MEMORY_VECTOR_BENCHMARK_VERSION = 'agent-memory-vector-benchmark-v1';

interface RankedVector {
  id: number;
  score: number;
}

export interface AgentMemoryVectorBenchmarkReport {
  benchmarkVersion: string;
  datasetKind: 'deterministic_synthetic_vectors';
  corpusSize: number;
  dimension: number;
  queryCount: number;
  topK: number;
  hnswEfSearch: number;
  exactSqlMatchesApplication: boolean;
  hnswRecallAtK: number;
  hnswMeanReciprocalRank: number;
  applicationExactLatencyMs: { p50: number; p95: number };
  postgresExactLatencyMs: { p50: number; p95: number };
  postgresHnswLatencyMs: { p50: number; p95: number };
  latencyScope: 'single_client_local_round_trip';
}

const percentile = (values: readonly number[], quantile: number) => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
};

const latencySummary = (values: readonly number[]) => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
});

const normalize = (vector: number[]) => {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) throw new Error('Cannot normalize an empty vector');
  return vector.map((value) => value / magnitude);
};

const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
};

export const createDeterministicVectorCorpus = (input: {
  corpusSize: number;
  dimension: number;
  queryCount: number;
  seed?: number;
}) => {
  const corpusSize = Math.max(100, Math.min(100_000, Math.floor(input.corpusSize)));
  const dimension = Math.max(2, Math.min(2_000, Math.floor(input.dimension)));
  const queryCount = Math.max(1, Math.min(1_000, Math.floor(input.queryCount)));
  const random = createRandom(input.seed ?? 0x5eed1234);
  const corpus = Array.from({ length: corpusSize }, (_, index) => ({
    id: index + 1,
    vector: normalize(Array.from({ length: dimension }, () => random() * 2 - 1)),
  }));
  const queries = Array.from({ length: queryCount }, (_, index) => {
    const base = corpus[(index * 7919) % corpus.length].vector;
    const noise = normalize(Array.from({ length: dimension }, () => random() * 2 - 1));
    return normalize(base.map((value, component) => value * 0.94 + noise[component] * 0.06));
  });
  return { corpus, queries };
};

const cosine = (left: readonly number[], right: readonly number[]) => {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
  return dot;
};

const rankApplicationExact = (
  corpus: readonly { id: number; vector: readonly number[] }[],
  query: readonly number[],
  topK: number,
) => corpus
  .map((item): RankedVector => ({ id: item.id, score: cosine(item.vector, query) }))
  .sort((left, right) => right.score - left.score || left.id - right.id)
  .slice(0, topK)
  .map((item) => item.id);

const vectorLiteral = (vector: readonly number[]) => (
  `[${vector.map((value) => Number(value.toFixed(9))).join(',')}]`
);

const insertCorpus = async (
  client: PoolClient,
  corpus: readonly { id: number; vector: readonly number[] }[],
) => {
  const batchSize = 200;
  for (let offset = 0; offset < corpus.length; offset += batchSize) {
    const batch = corpus.slice(offset, offset + batchSize);
    const parameters: unknown[] = [];
    const values = batch.map((item, index) => {
      parameters.push(item.id, vectorLiteral(item.vector));
      return `($${index * 2 + 1}, $${index * 2 + 2}::vector)`;
    });
    await client.query(
      `insert into agent_memory_vector_benchmark (id, embedding)
       values ${values.join(', ')}`,
      parameters,
    );
  }
};

const queryVectorIds = async (
  client: PoolClient,
  query: readonly number[],
  topK: number,
) => {
  const startedAt = performance.now();
  const { rows } = await client.query<{ id: number }>(
    `select id
     from agent_memory_vector_benchmark
     order by embedding <=> $1::vector
     limit $2`,
    [vectorLiteral(query), topK],
  );
  return {
    ids: rows.map((row) => row.id),
    latencyMs: performance.now() - startedAt,
  };
};

const recallAtK = (expected: readonly number[], actual: readonly number[]) => {
  const actualSet = new Set(actual);
  return expected.filter((id) => actualSet.has(id)).length / expected.length;
};

const reciprocalRank = (expected: readonly number[], actual: readonly number[]) => {
  const expectedSet = new Set(expected);
  const index = actual.findIndex((id) => expectedSet.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
};

/**
 * Compare the current application exact scan with pgvector exact cosine and HNSW.
 * Synthetic vectors isolate index mechanics; this is not a semantic quality eval.
 * The caller must point at an expendable benchmark database with pgvector available.
 */
export const runAgentMemoryVectorBenchmark = async (input: {
  connectionString: string;
  corpusSize?: number;
  dimension?: number;
  queryCount?: number;
  topK?: number;
  hnswEfSearch?: number;
}): Promise<AgentMemoryVectorBenchmarkReport> => {
  if (!input.connectionString) throw new Error('A benchmark database URL is required');
  const corpusSize = Math.max(100, Math.min(100_000, Math.floor(input.corpusSize ?? 5_000)));
  const dimension = Math.max(2, Math.min(2_000, Math.floor(input.dimension ?? 64)));
  const queryCount = Math.max(1, Math.min(1_000, Math.floor(input.queryCount ?? 40)));
  const topK = Math.max(1, Math.min(100, Math.floor(input.topK ?? 10)));
  const hnswEfSearch = Math.max(topK, Math.min(1_000, Math.floor(input.hnswEfSearch ?? 100)));
  const generated = createDeterministicVectorCorpus({ corpusSize, dimension, queryCount });
  const pool = new Pool({ connectionString: input.connectionString, max: 1 });
  const client = await pool.connect();

  try {
    await client.query('create extension if not exists vector');
    await client.query(
      `create temporary table agent_memory_vector_benchmark (
         id integer primary key,
         embedding vector(${dimension}) not null
       ) on commit preserve rows`,
    );
    await insertCorpus(client, generated.corpus);
    await client.query('analyze agent_memory_vector_benchmark');

    const expectedByQuery: number[][] = [];
    const applicationLatency: number[] = [];
    const postgresExactLatency: number[] = [];
    let exactSqlMatchesApplication = true;
    for (const query of generated.queries) {
      const startedAt = performance.now();
      const expected = rankApplicationExact(generated.corpus, query, topK);
      applicationLatency.push(performance.now() - startedAt);
      expectedByQuery.push(expected);
      const exact = await queryVectorIds(client, query, topK);
      postgresExactLatency.push(exact.latencyMs);
      if (exact.ids.join(',') !== expected.join(',')) exactSqlMatchesApplication = false;
    }

    await client.query(
      `create index agent_memory_vector_benchmark_hnsw_idx
       on agent_memory_vector_benchmark
       using hnsw (embedding vector_cosine_ops)`,
    );
    await client.query('analyze agent_memory_vector_benchmark');
    await client.query(`set hnsw.ef_search = ${hnswEfSearch}`);
    await client.query('set enable_seqscan = off');

    const postgresHnswLatency: number[] = [];
    const hnswRecalls: number[] = [];
    const hnswReciprocalRanks: number[] = [];
    for (let index = 0; index < generated.queries.length; index += 1) {
      const approximate = await queryVectorIds(client, generated.queries[index], topK);
      postgresHnswLatency.push(approximate.latencyMs);
      hnswRecalls.push(recallAtK(expectedByQuery[index], approximate.ids));
      hnswReciprocalRanks.push(reciprocalRank(expectedByQuery[index], approximate.ids));
    }

    return {
      benchmarkVersion: AGENT_MEMORY_VECTOR_BENCHMARK_VERSION,
      datasetKind: 'deterministic_synthetic_vectors',
      corpusSize,
      dimension,
      queryCount,
      topK,
      hnswEfSearch,
      exactSqlMatchesApplication,
      hnswRecallAtK: hnswRecalls.reduce((sum, value) => sum + value, 0) / hnswRecalls.length,
      hnswMeanReciprocalRank: hnswReciprocalRanks.reduce(
        (sum, value) => sum + value,
        0,
      ) / hnswReciprocalRanks.length,
      applicationExactLatencyMs: latencySummary(applicationLatency),
      postgresExactLatencyMs: latencySummary(postgresExactLatency),
      postgresHnswLatencyMs: latencySummary(postgresHnswLatency),
      latencyScope: 'single_client_local_round_trip',
    };
  } finally {
    client.release();
    await pool.end();
  }
};

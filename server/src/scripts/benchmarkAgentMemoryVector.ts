import { runAgentMemoryVectorBenchmark } from '../evals/agent-memory-vector-benchmark';
import { toSafeError } from '../lib/safeError';

const connectionString = process.env.AGENT_MEMORY_VECTOR_BENCH_DATABASE_URL
  || process.env.TEST_DATABASE_URL
  || '';

runAgentMemoryVectorBenchmark({ connectionString })
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (!report.exactSqlMatchesApplication || report.hnswRecallAtK < 0.95) process.exitCode = 1;
  })
  .catch((error: unknown) => {
    console.error('[AgentMemoryVectorBenchmark] Failed:', toSafeError(error));
    process.exitCode = 1;
  });

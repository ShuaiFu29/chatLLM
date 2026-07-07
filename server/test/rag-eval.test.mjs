import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');
const readOptionalSource = (relativePath) => {
  const fullPath = path.join(serverRoot, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
};

test('RAG eval migration creates datasets cases runs and results', () => {
  const migrationSource = readOptionalSource('migrations/0007_rag_eval.sql');
  const answerScoreMigrationSource = readOptionalSource('migrations/0008_rag_eval_answer_score.sql');
  const asyncRunMigrationSource = readOptionalSource('migrations/0009_rag_eval_async_runs.sql');
  const asyncSafetyMigrationSource = readOptionalSource('migrations/0010_rag_eval_async_safety.sql');
  const cancelMigrationSource = readOptionalSource('migrations/0011_rag_eval_cancelled_runs.sql');
  const queueMigrationSource = readOptionalSource('migrations/0012_rag_eval_job_queue.sql');
  const historyIndexMigrationSource = readOptionalSource('migrations/0014_rag_history_indexes.sql');
  const strictMetricsMigrationSource = readOptionalSource('migrations/0015_rag_eval_strict_metrics.sql');

  assert.match(migrationSource, /create table if not exists rag_eval_datasets/i);
  assert.match(migrationSource, /create table if not exists rag_eval_cases/i);
  assert.match(migrationSource, /create table if not exists rag_eval_runs/i);
  assert.match(migrationSource, /create table if not exists rag_eval_results/i);
  assert.match(migrationSource, /expected_keywords text\[\] not null default '\{\}'::text\[\]/i);
  assert.match(migrationSource, /rag_eval_runs_dataset_created_idx/i);
  assert.match(answerScoreMigrationSource, /add column if not exists average_answer_score/i);
  assert.match(answerScoreMigrationSource, /add column if not exists answer_score/i);
  assert.match(asyncRunMigrationSource, /constraint rag_eval_runs_status_check/i);
  assert.match(asyncRunMigrationSource, /'running'/i);
  assert.match(asyncRunMigrationSource, /rag_eval_runs_running_user_idx/i);
  assert.match(asyncSafetyMigrationSource, /rag_eval_runs_one_running_dataset_idx/i);
  assert.match(asyncSafetyMigrationSource, /where status = 'running'/i);
  assert.match(cancelMigrationSource, /constraint rag_eval_runs_status_check/i);
  assert.match(cancelMigrationSource, /'cancelled'/i);
  assert.match(queueMigrationSource, /add column if not exists queued_at/i);
  assert.match(queueMigrationSource, /add column if not exists claimed_at/i);
  assert.match(queueMigrationSource, /add column if not exists worker_id/i);
  assert.match(queueMigrationSource, /add column if not exists attempts/i);
  assert.match(queueMigrationSource, /add column if not exists max_attempts/i);
  assert.match(queueMigrationSource, /add column if not exists next_attempt_at/i);
  assert.match(queueMigrationSource, /add column if not exists last_error/i);
  assert.match(queueMigrationSource, /rag_eval_runs_queue_ready_idx/i);
  assert.match(queueMigrationSource, /rag_eval_runs_claimed_idx/i);
  assert.match(historyIndexMigrationSource, /rag_runs_user_created_idx/i);
  assert.match(historyIndexMigrationSource, /on rag_runs \(user_id, created_at desc\)/i);
  assert.match(strictMetricsMigrationSource, /average_source_recall_score/i);
  assert.match(strictMetricsMigrationSource, /average_source_precision_score/i);
  assert.match(strictMetricsMigrationSource, /average_citation_accuracy_score/i);
  assert.match(strictMetricsMigrationSource, /average_grounding_score/i);
  assert.match(strictMetricsMigrationSource, /source_recall_score/i);
  assert.match(strictMetricsMigrationSource, /source_precision_score/i);
  assert.match(strictMetricsMigrationSource, /citation_accuracy_score/i);
  assert.match(strictMetricsMigrationSource, /grounding_score/i);
  assert.match(strictMetricsMigrationSource, /latency_ms/i);
});

test('RAG eval API exposes authenticated dataset case and run endpoints', () => {
  const indexSource = readSource('src/index.ts');
  const shutdownSource = readSource('src/lib/gracefulShutdown.ts');
  const routesSource = readOptionalSource('src/routes/ragEval.ts');
  const controllerSource = readOptionalSource('src/controllers/ragEval.ts');
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');
  const ragClientSource = readSource('src/lib/ragClient.ts');

  assert.match(indexSource, /ragEvalRoutes/);
  assert.match(indexSource, /app\.use\('\/api\/rag-eval', createRateLimit\(/);
  assert.match(indexSource, /keyPrefix:\s*'rag-eval'/);
  assert.match(indexSource, /max:\s*serverEnv\.RAG_EVAL_RATE_LIMIT_MAX/);
  assert.match(indexSource, /\), ragEvalRoutes\)/);
  assert.match(indexSource, /ragEvalQueue/);
  assert.match(indexSource, /ragEvalQueue\.start\(\)/);
  assert.match(shutdownSource, /ragEvalQueue/);
  assert.match(shutdownSource, /ragEvalQueue\.stop\(\)/);

  assert.match(routesSource, /router\.get\('\/datasets', requireAuth, listRagEvalDatasets\)/);
  assert.match(routesSource, /router\.post\('\/datasets', requireAuth, createRagEvalDataset\)/);
  assert.match(routesSource, /router\.patch\('\/datasets\/:datasetId', requireAuth, updateRagEvalDataset\)/);
  assert.match(routesSource, /router\.delete\('\/datasets\/:datasetId', requireAuth, deleteRagEvalDataset\)/);
  assert.match(routesSource, /router\.get\('\/datasets\/:datasetId\/quality', requireAuth, getRagEvalQualitySummary\)/);
  assert.match(routesSource, /router\.post\('\/datasets\/:datasetId\/cases', requireAuth, createRagEvalCase\)/);
  assert.match(routesSource, /router\.post\('\/datasets\/:datasetId\/runs', requireAuth, runRagEvalDataset\)/);
  assert.match(routesSource, /router\.get\('\/runs\/:runId', requireAuth, getRagEvalRun\)/);
  assert.match(routesSource, /router\.post\('\/runs\/:runId\/cancel', requireAuth, cancelRagEvalRun\)/);

  assert.match(controllerSource, /listRagEvalDatasets/);
  assert.match(controllerSource, /updateRagEvalDataset/);
  assert.match(controllerSource, /deleteRagEvalDataset/);
  assert.match(controllerSource, /getRagEvalQualitySummary/);
  assert.match(controllerSource, /getRagEvalRun/);
  assert.match(controllerSource, /createRunningRagEvalRunForUser/);
  assert.match(controllerSource, /cancelRagEvalRunForUser/);
  assert.match(controllerSource, /cancelRagEvalRun/);
  assert.match(controllerSource, /if \(run\.created\) \{/);
  assert.match(controllerSource, /recordRagEvalRunStarted/);
  assert.match(controllerSource, /recordRagEvalRunReused/);
  assert.match(controllerSource, /recordRagEvalRunCompleted/);
  assert.doesNotMatch(controllerSource, /executeRagEvalRunInBackground/);
  assert.doesNotMatch(controllerSource, /void\s+executeRagEvalRunInBackground/);
  assert.doesNotMatch(controllerSource, /runRagEvaluation/);
  assert.match(controllerSource, /res\.status\(202\)\.json\(run\)/);

  assert.match(repositorySource, /listRagEvalDatasetsForUser/);
  assert.match(repositorySource, /createRagEvalDatasetForUser/);
  assert.match(repositorySource, /updateRagEvalDatasetForUser/);
  assert.match(repositorySource, /deleteRagEvalDatasetForUser/);
  assert.match(repositorySource, /getRagEvalQualitySummaryForUser/);
  assert.match(repositorySource, /createRagEvalCaseForUser/);
  assert.match(repositorySource, /getRagEvalRunForUser/);
  assert.match(repositorySource, /createRunningRagEvalRunForUser/);
  assert.match(repositorySource, /completeRagEvalRunWithResults/);
  assert.match(repositorySource, /failRagEvalRunForUser/);
  assert.match(repositorySource, /claimNextRagEvalRunJob/);
  assert.match(repositorySource, /markRagEvalRunAttemptFailed/);
  assert.match(repositorySource, /resetStaleRagEvalRunJobs/);
  assert.match(repositorySource, /cancelRagEvalRunForUser/);
  assert.match(repositorySource, /status = 'cancelled'/);
  assert.match(repositorySource, /RagEvalRunStatus = 'running'/);
  assert.match(repositorySource, /status in \('running'\)/i);
  assert.match(repositorySource, /on conflict \(dataset_id\) where status = 'running' do nothing/i);
  assert.match(repositorySource, /created: true/);
  assert.match(repositorySource, /created: false/);
  assert.match(repositorySource, /failStaleRunningRagEvalRuns/);
  assert.match(repositorySource, /delete from rag_eval_datasets/i);
  assert.match(repositorySource, /where id = \$1 and user_id = \$2/i);
  assert.match(repositorySource, /from rag_eval_results/);
  assert.match(repositorySource, /where d\.user_id = \$1/i);
  assert.match(repositorySource, /average_answer_score/);
  assert.match(repositorySource, /answer_score/);
  assert.match(repositorySource, /average_source_recall_score/);
  assert.match(repositorySource, /source_recall_score/);
  assert.match(repositorySource, /average_citation_accuracy_score/);
  assert.match(repositorySource, /citation_accuracy_score/);
  assert.match(repositorySource, /average_grounding_score/);
  assert.match(repositorySource, /grounding_score/);

  assert.match(ragClientSource, /runRagEvaluation/);
  assert.match(ragClientSource, /\/eval\/run/);
  assert.match(ragClientSource, /expected_answer\?: string/);
  assert.match(ragClientSource, /average_source_recall_score/);
  assert.match(ragClientSource, /citation_accuracy_score/);
});

test('RAG eval exposes dataset quality trend and low-score case summaries', () => {
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');
  const controllerSource = readOptionalSource('src/controllers/ragEval.ts');

  assert.match(repositorySource, /interface RagEvalQualitySummary/);
  assert.match(repositorySource, /trend_delta/);
  assert.match(repositorySource, /low_score_cases/);
  assert.match(repositorySource, /average_overall_score/);
  assert.match(repositorySource, /from rag_eval_runs/);
  assert.match(repositorySource, /from rag_eval_results/);
  assert.match(repositorySource, /order by overall_score asc/i);
  assert.match(repositorySource, /limit 5/i);

  assert.match(controllerSource, /getRagEvalQualitySummaryForUser/);
  assert.match(controllerSource, /res\.json\(summary\)/);
});

test('RAG eval exposes historical chat RAG runs for the quality center', () => {
  const routesSource = readOptionalSource('src/routes/ragEval.ts');
  const controllerSource = readOptionalSource('src/controllers/ragEval.ts');
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');

  assert.match(routesSource, /router\.get\('\/history', requireAuth, listRagEvalHistory\)/);
  assert.match(controllerSource, /DEFAULT_RAG_EVAL_HISTORY_LIMIT = 50/);
  assert.match(controllerSource, /MAX_RAG_EVAL_HISTORY_LIMIT = 200/);
  assert.match(controllerSource, /listRagEvalHistory/);
  assert.match(controllerSource, /listHistoricalRagRunsForUser\(req\.user\.id, historyLimit\)/);
  assert.match(controllerSource, /res\.json\(\{ items: history \}\)/);

  assert.match(repositorySource, /interface RagEvalHistoryItem/);
  assert.match(repositorySource, /listHistoricalRagRunsForUser/);
  assert.match(repositorySource, /from rag_runs rr/i);
  assert.match(repositorySource, /join conversations c on c\.id = rr\.conversation_id/i);
  assert.match(repositorySource, /left join messages am on am\.id = rr\.assistant_message_id/i);
  assert.match(repositorySource, /left join project_spaces ps on ps\.id = c\.project_space_id/i);
  assert.match(repositorySource, /where rr\.user_id = \$1/i);
  assert.match(repositorySource, /order by rr\.created_at desc\s+limit \$2/i);
});

test('RAG eval queue worker claims persisted jobs and retries safely', () => {
  const queueSource = readOptionalSource('src/services/ragEvalQueue.ts');
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');
  const maintenanceSource = readOptionalSource('src/services/maintenance.ts');
  const metricsSource = readOptionalSource('src/lib/metrics.ts');

  assert.match(queueSource, /class RagEvalQueueService/);
  assert.match(queueSource, /claimNextRagEvalRunJob/);
  assert.match(queueSource, /runRagEvaluation/);
  assert.match(queueSource, /completeRagEvalRunWithResults/);
  assert.match(queueSource, /markRagEvalRunAttemptFailed/);
  assert.match(queueSource, /workerId:\s*job\.worker_id \|\| this\.workerId/);
  assert.match(queueSource, /RAG_EVAL_QUEUE_CONCURRENCY/);
  assert.match(queueSource, /RAG_EVAL_QUEUE_INTERVAL_MS/);
  assert.match(queueSource, /RAG_EVAL_QUEUE_MAX_ATTEMPTS/);
  assert.match(queueSource, /RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS/);
  assert.match(queueSource, /RAG_EVAL_QUEUE_STALE_AFTER_MS/);

  assert.match(repositorySource, /for update skip locked/i);
  assert.match(repositorySource, /worker_id/);
  assert.match(repositorySource, /claimed_at/);
  assert.match(repositorySource, /next_attempt_at/);
  assert.match(repositorySource, /last_error/);
  assert.match(repositorySource, /status = 'running'/);
  assert.match(repositorySource, /worker_id = \$18/);
  assert.match(repositorySource, /worker_id = \$8/);

  assert.match(maintenanceSource, /resetStaleRagEvalRunJobs/);
  assert.match(metricsSource, /recordRagEvalRunRetried/);
  assert.match(metricsSource, /recordRagEvalRunQueueClaimed/);
});

test('RAG eval runs are bounded before calling the RAG service', () => {
  const controllerSource = readOptionalSource('src/controllers/ragEval.ts');
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');
  const queueSource = readOptionalSource('src/services/ragEvalQueue.ts');

  assert.match(controllerSource, /MAX_RAG_EVAL_CASES_PER_RUN = 50/);
  assert.match(controllerSource, /MAX_RAG_EVAL_CASES_PER_DATASET = 50/);
  assert.match(controllerSource, /dataset\.cases\.length >= MAX_RAG_EVAL_CASES_PER_DATASET/);
  assert.match(controllerSource, /dataset\.cases\.length > MAX_RAG_EVAL_CASES_PER_RUN/);
  assert.match(
    controllerSource,
    /return res\.status\(400\)\.json\(\{ error: 'Dataset has too many eval cases' \}\)/
  );
  assert.match(
    controllerSource,
    /return res\.status\(400\)\.json\(\{ error: 'Dataset has too many eval cases for one run' \}\)/
  );
  assert.match(controllerSource, /maxCases: MAX_RAG_EVAL_CASES_PER_DATASET/);
  assert.match(queueSource, /expected_answer: testCase\.expected_answer/);
  assert.match(repositorySource, /count\(\*\)::int from rag_eval_cases/i);
  assert.match(repositorySource, /case_count < \$7/i);
});

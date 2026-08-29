import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
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
  const verificationMigrationSource = readOptionalSource('migrations/0018_rag_eval_verification_metrics.sql');
  const answerSupportMigrationSource = readOptionalSource('migrations/0019_rag_eval_expected_answer_support.sql');

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
  assert.match(verificationMigrationSource, /average_verification_score/i);
  assert.match(verificationMigrationSource, /verification_score/i);
  assert.match(verificationMigrationSource, /support_label/i);
  assert.match(answerSupportMigrationSource, /average_expected_answer_support_score/i);
  assert.match(answerSupportMigrationSource, /expected_answer_support_score/i);
  assert.match(answerSupportMigrationSource, /expected_answer_support_label/i);
});

test('RAG eval API exposes authenticated dataset case and run endpoints', () => {
  const nestControllerSource = readSource('src/modules/rag-eval/rag-eval.controller.ts');
  const moduleSource = readSource('src/modules/rag-eval/rag-eval.module.ts');
  const lifecycleSource = readSource('src/infrastructure/runtime-lifecycle.service.ts');
  const serviceSource = readSource('src/modules/rag-eval/rag-eval.service.ts');
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');
  const ragClientSource = readSource('src/lib/ragClient.ts');

  assert.match(nestControllerSource, /@Controller\('rag-eval'\)/);
  assert.match(nestControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(nestControllerSource, /@RateLimitScope\(\{[\s\S]*?keyPrefix:\s*'rag-eval',[\s\S]*?max:\s*serverEnv\.RAG_EVAL_RATE_LIMIT_MAX/);
  assert.match(
    lifecycleSource,
    /const queues = \[\s*fileQueue,\s*ragEvalQueue,\s*agentEvalQueue,\s*artifactCleanupQueue,\s*agentRecoveryQueue,\s*agentMemoryEmbeddingQueue,\s*\] as const;/,
  );
  assert.match(lifecycleSource, /queues\.map\(\(queue\) => queue\.start\(\)\)/);
  assert.match(lifecycleSource, /queues\.map\(\(queue\) => queue\.stop\(\)\)/);

  assert.match(nestControllerSource, /constructor\(private readonly ragEvalService: RagEvalService\)/);
  assert.match(nestControllerSource, /@Get\('datasets'\)[\s\S]*?@CurrentUser\(\)[\s\S]*?this\.ragEvalService\.listDatasets\(user\.id, requestId\)/);
  assert.match(nestControllerSource, /@Post\('datasets'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.ragEvalDatasetCreate\)[\s\S]*?@Body\(\)[\s\S]*?this\.ragEvalService\.createDataset\(user\.id, body, requestId\)/);
  assert.match(nestControllerSource, /@Patch\('datasets\/:datasetId'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.ragEvalDatasetUpdate\)[\s\S]*?@Param\('datasetId'\)[\s\S]*?this\.ragEvalService\.updateDataset\(user\.id, datasetId, body, requestId\)/);
  assert.match(nestControllerSource, /@Delete\('datasets\/:datasetId'\)[\s\S]*?this\.ragEvalService\.deleteDataset\(user\.id, datasetId, requestId\)/);
  assert.match(nestControllerSource, /@Get\('datasets\/:datasetId\/quality'\)[\s\S]*?this\.ragEvalService\.qualitySummary\(user\.id, datasetId, requestId\)/);
  assert.match(nestControllerSource, /@Post\('datasets\/:datasetId\/cases'\)[\s\S]*?this\.ragEvalService\.createCase\(user\.id, datasetId, body, requestId\)/);
  assert.match(nestControllerSource, /@Post\('datasets\/:datasetId\/runs'\)[\s\S]*?@HttpCode\(202\)[\s\S]*?this\.ragEvalService\.runDataset\(user\.id, datasetId, requestId\)/);
  assert.match(nestControllerSource, /@Get\('runs\/:runId'\)[\s\S]*?this\.ragEvalService\.getRun\(user\.id, runId, requestId\)/);
  assert.match(nestControllerSource, /@Post\('runs\/:runId\/cancel'\)[\s\S]*?@HttpCode\(200\)[\s\S]*?this\.ragEvalService\.cancelRun\(user\.id, runId, requestId\)/);
  assert.doesNotMatch(nestControllerSource, /@Res\(|@Req\(|AppReply|AppRequest/);
  assert.match(moduleSource, /providers:\s*\[AuthGuard, RagEvalService\]/);
  assert.equal(existsSync(path.join(serverRoot, 'src/controllers/ragEval.ts')), false);

  assert.match(serviceSource, /@Injectable\(\)/);
  assert.match(serviceSource, /listRagEvalDatasetsForUser/);
  assert.match(serviceSource, /updateRagEvalDatasetForUser/);
  assert.match(serviceSource, /deleteRagEvalDatasetForUser/);
  assert.match(serviceSource, /getRagEvalQualitySummaryForUser/);
  assert.match(serviceSource, /getRagEvalRunForUser/);
  assert.match(serviceSource, /createRunningRagEvalRunForUser/);
  assert.match(serviceSource, /cancelRagEvalRunForUser/);
  assert.match(serviceSource, /if \(run\.created\) \{/);
  assert.match(serviceSource, /recordRagEvalRunStarted/);
  assert.match(serviceSource, /recordRagEvalRunReused/);
  assert.match(serviceSource, /recordRagEvalRunCompleted/);
  assert.doesNotMatch(serviceSource, /executeRagEvalRunInBackground/);
  assert.doesNotMatch(serviceSource, /void\s+executeRagEvalRunInBackground/);
  assert.doesNotMatch(serviceSource, /runRagEvaluation/);
  assert.doesNotMatch(serviceSource, /AppReply|AppRequest|res\.code|res\.send/);

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
  assert.match(repositorySource, /average_verification_score/);
  assert.match(repositorySource, /verification_score/);
  assert.match(repositorySource, /support_label/);
  assert.match(repositorySource, /average_expected_answer_support_score/);
  assert.match(repositorySource, /expected_answer_support_score/);
  assert.match(repositorySource, /expected_answer_support_label/);

  assert.match(ragClientSource, /runRagEvaluation/);
  assert.match(ragClientSource, /\/eval\/run/);
  assert.match(ragClientSource, /expected_answer\?: string/);
  assert.match(ragClientSource, /average_source_recall_score/);
  assert.match(ragClientSource, /citation_accuracy_score/);
  assert.match(ragClientSource, /average_verification_score/);
  assert.match(ragClientSource, /verification_score/);
  assert.match(ragClientSource, /average_expected_answer_support_score/);
  assert.match(ragClientSource, /expected_answer_support_score/);
  assert.match(ragClientSource, /expected_answer_support_label/);
});

test('RAG eval native Nest controller preserves async run status and forwards route values', async () => {
  require('reflect-metadata');
  const { HTTP_CODE_METADATA } = require('@nestjs/common/constants');
  const { RagEvalController } = require(path.join(
    serverRoot,
    'dist',
    'modules',
    'rag-eval',
    'rag-eval.controller.js',
  ));
  const expected = { id: 'run-one', created: true };
  const calls = [];
  const controller = new RagEvalController({
    runDataset: async (...args) => {
      calls.push(args);
      return expected;
    },
  });

  const result = await controller.runDataset(
    { id: 'user-one' },
    'dataset-one',
    'request-one',
  );
  assert.equal(result, expected);
  assert.deepEqual(calls, [['user-one', 'dataset-one', 'request-one']]);
  assert.equal(
    Reflect.getMetadata(HTTP_CODE_METADATA, RagEvalController.prototype.runDataset),
    202,
  );
  assert.equal(
    Reflect.getMetadata(HTTP_CODE_METADATA, RagEvalController.prototype.cancelRun),
    200,
  );
});

test('RAG eval exposes dataset quality trend and low-score case summaries', () => {
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');
  const serviceSource = readSource('src/modules/rag-eval/rag-eval.service.ts');

  assert.match(repositorySource, /interface RagEvalQualitySummary/);
  assert.match(repositorySource, /trend_delta/);
  assert.match(repositorySource, /low_score_cases/);
  assert.match(repositorySource, /average_overall_score/);
  assert.match(repositorySource, /from rag_eval_runs/);
  assert.match(repositorySource, /from rag_eval_results/);
  assert.match(repositorySource, /order by overall_score asc/i);
  assert.match(repositorySource, /limit 5/i);

  assert.match(serviceSource, /getRagEvalQualitySummaryForUser\(datasetId, userId\)/);
  assert.match(serviceSource, /return summary/);
});

test('RAG eval exposes historical chat RAG runs for the quality center', () => {
  const nestControllerSource = readSource('src/modules/rag-eval/rag-eval.controller.ts');
  const serviceSource = readSource('src/modules/rag-eval/rag-eval.service.ts');
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');

  assert.match(nestControllerSource, /@Controller\('rag-eval'\)/);
  assert.match(nestControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(nestControllerSource, /@Get\('history'\)[\s\S]*?@Query\('limit'\)[\s\S]*?this\.ragEvalService\.history\(user\.id, limit, requestId\)/);
  assert.match(serviceSource, /DEFAULT_RAG_EVAL_HISTORY_LIMIT = 50/);
  assert.match(serviceSource, /MAX_RAG_EVAL_HISTORY_LIMIT = 200/);
  assert.match(serviceSource, /async history\(userId: string, limit: unknown/);
  assert.match(serviceSource, /listHistoricalRagRunsForUser\(userId, historyLimit\)/);
  assert.match(serviceSource, /return \{ items: history \}/);

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
  assert.match(queueSource, /claimRagEvalRunJobById/);
  assert.match(queueSource, /listDispatchableRagEvalRunIds/);
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
  assert.match(maintenanceSource, /resetStaleRagEvalRunJobs/);
  assert.match(metricsSource, /recordRagEvalRunRetried/);
  assert.match(metricsSource, /recordRagEvalRunQueueClaimed/);
});

test('RAG eval claims and terminal writes are fenced by renewable leases', () => {
  const migrationSource = readOptionalSource('migrations/0027_rag_eval_snapshots_leases.sql');
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');
  const queueSource = readOptionalSource('src/services/ragEvalQueue.ts');
  const serviceSource = readSource('src/modules/rag-eval/rag-eval.service.ts');

  assert.match(migrationSource, /add column if not exists lease_token uuid/i);
  assert.match(migrationSource, /add column if not exists heartbeat_at timestamptz/i);
  assert.match(migrationSource, /add column if not exists lease_expires_at timestamptz/i);
  assert.match(migrationSource, /add column if not exists deadline_at timestamptz/i);
  assert.match(migrationSource, /add column if not exists case_timeout_ms integer/i);
  assert.match(migrationSource, /rag_eval_runs_lease_expiry_idx/i);
  assert.match(migrationSource, /rag_eval_runs_deadline_idx/i);

  assert.match(repositorySource, /export const renewRagEvalRunLease/);
  assert.match(repositorySource, /lease_token = gen_random_uuid\(\)/i);
  assert.match(repositorySource, /heartbeat_at = now\(\)/i);
  assert.match(repositorySource, /lease_expires_at = now\(\) \+/i);
  assert.match(repositorySource, /worker_id = \$[0-9]+[\s\S]*lease_token = \$[0-9]+/i);
  assert.match(repositorySource, /lease_expires_at > now\(\)/i);
  assert.match(repositorySource, /deadline_at > now\(\)/i);

  assert.match(queueSource, /executeRagEvalRequest/);
  assert.match(queueSource, /RAG_EVAL_QUEUE_STALE_AFTER_MS \/ 4/);
  assert.match(queueSource, /new AbortController\(\)/);
  assert.match(queueSource, /abortRun\(runId: string\)/);
  assert.match(serviceSource, /ragEvalQueue\.abortRun\(run\.id\)/);
});

test('RAG eval request execution forwards the claim and stops its heartbeat', async () => {
  const queue = require(path.join(serverRoot, 'dist', 'services', 'ragEvalQueue.js'));
  assert.equal(typeof queue.executeRagEvalRequest, 'function');

  const deadlineAt = '2026-07-13T10:01:00.000Z';
  const job = {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: 'user-1',
    worker_id: 'worker-1',
    lease_token: '22222222-2222-4222-8222-222222222222',
    deadline_at: deadlineAt,
    case_timeout_ms: 45000,
    dataset: {
      project_space_id: 'space-1',
      cases: [{
        id: 'case-1',
        question: 'What is fenced?',
        expected_answer: 'By a lease.',
        expected_keywords: ['lease'],
        expected_source_files: ['lease.md'],
      }],
    },
  };
  const expectedOutput = { case_count: 1, failed_count: 0, results: [] };
  const preparedCases = [{
    id: 'case-1',
    question: 'What is fenced?',
    expected_answer: 'By a lease.',
    expected_keywords: ['lease'],
    expected_source_files: ['lease.md'],
  }];
  const calls = [];
  let stopped = false;
  let unregistered = false;

  const result = await queue.executeRagEvalRequest(job, {
    now: () => Date.parse('2026-07-13T10:00:00.000Z'),
    runEvaluation: async (input, signal, timeoutMs) => {
      calls.push({ input, signal, timeoutMs });
      return expectedOutput;
    },
    prepareCases: async (_job, signal) => {
      assert.equal(signal.aborted, false);
      return preparedCases;
    },
    startHeartbeat: (_job, _onLeaseLost) => async () => { stopped = true; },
    registerController: (runId, leaseToken, controller) => {
      assert.equal(runId, job.id);
      assert.equal(leaseToken, job.lease_token);
      assert.equal(controller.signal.aborted, false);
      return () => { unregistered = true; };
    },
  });

  assert.equal(result, expectedOutput);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    run_id: job.id,
    lease_token: job.lease_token,
    deadline_at: deadlineAt,
    case_timeout_ms: 45000,
    user_id: 'user-1',
    project_space_id: 'space-1',
    cases: preparedCases,
    limit: 10,
    threshold: 0.1,
  });
  assert.equal(calls[0].signal.aborted, false);
  assert.equal(calls[0].timeoutMs, 60000);
  assert.equal(stopped, true);
  assert.equal(unregistered, true);
});

test('RAG eval request execution aborts before transport work after lease loss', async () => {
  const queue = require(path.join(serverRoot, 'dist', 'services', 'ragEvalQueue.js'));
  const job = {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: 'user-1',
    worker_id: 'worker-1',
    lease_token: '44444444-4444-4444-8444-444444444444',
    deadline_at: '2099-01-01T00:00:00.000Z',
    case_timeout_ms: 60000,
    dataset: { project_space_id: null, cases: [{ id: 'case-1', question: 'Stop?' }] },
  };
  let stopped = false;

  await assert.rejects(queue.executeRagEvalRequest(job, {
    runEvaluation: async (_input, signal) => {
      assert.equal(signal.aborted, true);
      throw new Error('evaluation aborted');
    },
    startHeartbeat: (_job, onLeaseLost) => {
      onLeaseLost();
      return () => { stopped = true; };
    },
    prepareCases: async (_job, signal) => {
      assert.equal(signal.aborted, true);
      throw new Error('evaluation aborted');
    },
    registerController: () => () => undefined,
  }), /evaluation aborted/);

  assert.equal(stopped, true);
});

test('RAG eval answer preparation enforces the timeout for each generated case', async () => {
  const { prepareRagEvalCases } = require(path.join(serverRoot, 'dist', 'services', 'ragEvalQueue.js'));
  const controller = new AbortController();
  const job = {
    id: '77777777-7777-4777-8777-777777777777',
    user_id: 'user-1',
    case_timeout_ms: 20,
    dataset: {
      project_space_id: null,
      cases: [
        { id: 'case-timeout', question: 'slow question' },
        { id: 'case-next', question: 'next question' },
      ],
    },
  };
  const generatedSignals = [];
  const cases = await prepareRagEvalCases(job, controller.signal, async ({ question, signal }) => {
    generatedSignals.push(signal);
    if (question === 'slow question') {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('case aborted')), { once: true });
      });
    }
    return {
      actualAnswer: 'answer',
      promptVersion: 'prompt-v1',
      modelVersion: 'model-v1',
      provider: 'test',
      tokenUsage: undefined,
      claimEvaluation: { verifier_version: 'verifier-v1' },
      prepared: {
        ragRun: { results: [] },
        answerContextDocuments: [],
        traceSummary: { trace_steps: [] },
      },
    };
  });

  assert.equal(cases[0].preparation_error, 'Answer generation case timeout');
  assert.equal(cases[1].actual_answer, 'answer');
  assert.equal(generatedSignals[0].aborted, true);
  assert.equal(generatedSignals[1].aborted, false);
});

test('RAG eval deadline aborts answer preparation before transport', async () => {
  const queue = require(path.join(serverRoot, 'dist', 'services', 'ragEvalQueue.js'));
  const deadline = Date.now() + 30;
  let transportCalled = false;

  await assert.rejects(queue.executeRagEvalRequest({
    id: '55555555-5555-4555-8555-555555555555',
    user_id: 'user-1',
    worker_id: 'worker-1',
    lease_token: '66666666-6666-4666-8666-666666666666',
    deadline_at: new Date(deadline).toISOString(),
    case_timeout_ms: 60000,
    dataset: { project_space_id: null, cases: [{ id: 'case-1', question: 'Timeout?' }] },
  }, {
    runEvaluation: async () => {
      transportCalled = true;
      return {};
    },
    startHeartbeat: () => () => undefined,
    prepareCases: async (_job, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('answer preparation deadline aborted')), { once: true });
    }),
    registerController: () => () => undefined,
  }), /answer preparation deadline aborted/);

  assert.equal(transportCalled, false);
});

test('RAG eval runs are bounded before calling the RAG service', () => {
  const serviceSource = readSource('src/modules/rag-eval/rag-eval.service.ts');
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');
  const queueSource = readOptionalSource('src/services/ragEvalQueue.ts');

  assert.match(serviceSource, /MAX_RAG_EVAL_CASES_PER_RUN = serverEnv\.RAG_EVAL_MAX_CASES_PER_RUN/);
  assert.match(serviceSource, /MAX_RAG_EVAL_CASES_PER_DATASET = serverEnv\.RAG_EVAL_MAX_CASES_PER_DATASET/);
  assert.match(serviceSource, /dataset\.cases\.length >= MAX_RAG_EVAL_CASES_PER_DATASET/);
  assert.match(serviceSource, /dataset\.cases\.length > MAX_RAG_EVAL_CASES_PER_RUN/);
  assert.match(
    serviceSource,
    /throw requestError\(400, 'Dataset has too many eval cases'\)/
  );
  assert.match(
    serviceSource,
    /throw requestError\(400, 'Dataset has too many eval cases for one run'\)/
  );
  assert.match(serviceSource, /maxCases: MAX_RAG_EVAL_CASES_PER_DATASET/);
  assert.match(queueSource, /expected_answer: testCase\.expected_answer/);
  assert.match(repositorySource, /from rag_eval_datasets[\s\S]*for update/i);
  assert.match(repositorySource, /case_count >= maxCases/);
  assert.match(repositorySource, /insert into rag_eval_run_cases/i);
});

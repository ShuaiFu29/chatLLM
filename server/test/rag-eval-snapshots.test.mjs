import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquirePostgresIntegrationLock } from './postgres-integration-lock.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const readOptionalSource = (relativePath) => {
  const fullPath = path.join(serverRoot, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
};
const integrationEnabled = process.env.RAG_EVAL_SNAPSHOT_INTEGRATION === '1'
  && Boolean(process.env.TEST_DATABASE_URL);

test('RAG eval snapshot migration and repository preserve immutable run cases', () => {
  const migrationSource = readOptionalSource('migrations/0027_rag_eval_snapshots_leases.sql');
  const reproducibilityMigrationSource = readOptionalSource('migrations/0030_rag_eval_reproducibility.sql');
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');
  const createRunBody = repositorySource
    .split('export const createRunningRagEvalRunForUser', 2)[1]
    ?.split('export const claimNextRagEvalRunJob', 1)[0] || '';
  const claimBody = repositorySource
    .split('export const claimNextRagEvalRunJob', 2)[1]
    ?.split('export const resetStaleRagEvalRunJobs', 1)[0] || '';

  assert.match(migrationSource, /create table if not exists rag_eval_run_cases/i);
  assert.match(migrationSource, /run_id uuid not null references rag_eval_runs\(id\) on delete cascade/i);
  assert.match(migrationSource, /case_id uuid not null/i);
  assert.doesNotMatch(migrationSource, /case_id uuid[^,]*references rag_eval_cases/i);
  assert.match(migrationSource, /ordinal integer not null/i);
  assert.match(migrationSource, /expected_answer text not null/i);
  assert.match(migrationSource, /expected_keywords text\[\] not null/i);
  assert.match(migrationSource, /expected_source_files text\[\] not null/i);
  assert.match(migrationSource, /unique \(run_id, ordinal\)/i);
  assert.match(reproducibilityMigrationSource, /execution_snapshot jsonb/i);
  assert.match(reproducibilityMigrationSource, /baseline_run_id uuid references rag_eval_runs/i);
  assert.match(reproducibilityMigrationSource, /answer_keyword_score drop not null/i);
  assert.match(reproducibilityMigrationSource, /set average_answer_keyword_score = null/i);
  assert.match(reproducibilityMigrationSource, /set answer_keyword_score = null/i);

  assert.match(createRunBody, /withTransaction/);
  assert.match(createRunBody, /for update/i);
  assert.match(createRunBody, /insert into rag_eval_run_cases/i);
  assert.match(createRunBody, /index_scopes/i);
  assert.match(createRunBody, /settings_fingerprint/i);
  assert.match(createRunBody, /execution_snapshot/i);
  assert.match(createRunBody, /baseline_run_id/i);
  assert.match(createRunBody, /row_number\(\) over/i);
  assert.match(claimBody, /from rag_eval_run_cases/i);
  assert.doesNotMatch(claimBody, /from rag_eval_cases/i);
  assert.match(repositorySource, /select id from rag_eval_cases where id = \$2/i);
  assert.match(repositorySource, /paired_comparison/i);
  assert.match(repositorySource, /current\.retrieval_score - baseline\.retrieval_score/i);
});

test('RAG eval case creation locks the dataset before enforcing its limit', () => {
  const repositorySource = readOptionalSource('src/repositories/ragEval.ts');
  const createCaseBody = repositorySource
    .split('export const createRagEvalCaseForUser', 2)[1]
    ?.split('export const deleteRagEvalCaseForUser', 1)[0] || '';

  assert.match(createCaseBody, /withTransaction/);
  assert.match(createCaseBody, /from rag_eval_datasets[\s\S]*for update/i);
  assert.match(createCaseBody, /count\(\*\)::int[\s\S]*from rag_eval_cases/i);
  assert.match(createCaseBody, /case_count >= maxCases/);
});

const successfulResult = (testCase) => ({
  case_id: testCase.id,
  question: testCase.question,
  status: 'success',
  overall_score: 1,
  retrieval_score: 1,
  answer_score: 1,
  source_score: 1,
  source_recall_score: 1,
  source_precision_score: 1,
  citation_accuracy_score: 1,
  keyword_score: 1,
  answer_keyword_score: null,
  grounding_score: 1,
  judge_score: 1,
  expected_answer_support_score: 1,
  expected_answer_support_label: 'supported',
  verification_score: 1,
  latency_ms: 1,
  evidence_label: 'strong',
  support_label: 'supported',
  risk_level: 'low',
  matched_sources: [],
  trace_summary: {},
  error_message: '',
  advanced_metrics: {
    answerability: { applicable: true, accuracy: 1, false_answer: 0, false_abstention: 0 },
  },
});

const successfulOutput = (cases) => ({
  case_count: cases.length,
  failed_count: 0,
  duration_ms: 2,
  average_overall_score: 1,
  average_retrieval_score: 1,
  average_answer_score: 1,
  average_source_score: 1,
  average_source_recall_score: 1,
  average_source_precision_score: 1,
  average_citation_accuracy_score: 1,
  average_keyword_score: 1,
  average_answer_keyword_score: null,
  average_grounding_score: 1,
  average_judge_score: 1,
  average_expected_answer_support_score: 1,
  average_verification_score: 1,
  advanced_metrics: {
    latency_ms: { applicable: true, p50: 1, p95: 1, max: 1 },
    cost: { applicable: false, reason: 'pricing not configured' },
  },
  results: cases.map(successfulResult),
});

test('PostgreSQL snapshots cases and serializes concurrent case-limit inserts', {
  skip: integrationEnabled
    ? false
    : 'set RAG_EVAL_SNAPSHOT_INTEGRATION=1 and TEST_DATABASE_URL to run',
}, async () => {
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  const { pool, closeDatabasePool } = require(path.join(serverRoot, 'dist', 'lib', 'db.js'));
  const { runMigrations } = require(path.join(serverRoot, 'dist', 'lib', 'migrations.js'));
  const repository = require(path.join(serverRoot, 'dist', 'repositories', 'ragEval.js'));
  const userId = randomUUID();
  const datasetId = randomUUID();
  const limitedDatasetId = randomUUID();
  const firstCaseId = randomUUID();
  const secondCaseId = randomUUID();
  const workerId = `snapshot-worker-${randomUUID()}`;
  const githubId = String(BigInt(Date.now()) * 10_000n + 217n);
  let releaseIntegrationLock = async () => undefined;

  try {
    releaseIntegrationLock = await acquirePostgresIntegrationLock(pool);
    await runMigrations();
    await pool.query(
      `insert into users (id, github_id, username, avatar_url, display_name)
       values ($1, $2, $3, '', $3)`,
      [userId, githubId, `eval-snapshot-${userId}`],
    );
    await pool.query(
      `insert into rag_eval_datasets (id, user_id, name)
       values ($1, $3, 'Snapshot dataset'), ($2, $3, 'Limit dataset')`,
      [datasetId, limitedDatasetId, userId],
    );
    await pool.query(
      `insert into rag_eval_cases (
         id, dataset_id, user_id, question, expected_answer,
         expected_keywords, expected_source_files, evaluation_spec, created_at, updated_at
       )
       values
         ($1, $3, $4, 'original question one', 'answer one', array['one'], array['one.md'], '{"expected_chunk_ids":["chunk-one"]}'::jsonb, now() - interval '2 seconds', now() - interval '2 seconds'),
         ($2, $3, $4, 'original question two', 'answer two', array['two'], array['two.md'], '{"expected_answerable":false}'::jsonb, now() - interval '1 second', now() - interval '1 second')`,
      [firstCaseId, secondCaseId, datasetId, userId],
    );

    const run = await repository.createRunningRagEvalRunForUser({
      userId,
      datasetId,
      caseCount: 2,
    });
    assert.equal(run.created, true);
    assert.equal(run.case_count, 2);
    const snapshotBeforeEdit = await pool.query(
      `select case_id, ordinal, question, expected_answer, expected_keywords, expected_source_files, evaluation_spec
       from rag_eval_run_cases
       where run_id = $1
       order by ordinal`,
      [run.id],
    );
    assert.deepEqual(snapshotBeforeEdit.rows, [
      {
        case_id: firstCaseId,
        ordinal: 0,
        question: 'original question one',
        expected_answer: 'answer one',
        expected_keywords: ['one'],
        expected_source_files: ['one.md'],
        evaluation_spec: { expected_chunk_ids: ['chunk-one'] },
      },
      {
        case_id: secondCaseId,
        ordinal: 1,
        question: 'original question two',
        expected_answer: 'answer two',
        expected_keywords: ['two'],
        expected_source_files: ['two.md'],
        evaluation_spec: { expected_answerable: false },
      },
    ]);

    await pool.query('delete from rag_eval_cases where id = $1', [firstCaseId]);
    await pool.query(
      `update rag_eval_cases
       set question = 'mutated question', expected_keywords = array['mutated']
       where id = $1`,
      [secondCaseId],
    );
    await pool.query(
      `insert into rag_eval_cases (dataset_id, user_id, question)
       values ($1, $2, 'new case after run creation')`,
      [datasetId, userId],
    );
    await pool.query(
      `update rag_eval_runs
       set queued_at = now() - interval '100 years'
       where id = $1`,
      [run.id],
    );

    const claimed = await repository.claimNextRagEvalRunJob({
      workerId,
      retryBaseDelayMs: 1,
      staleAfterMs: 60_000,
      maxAttempts: 3,
    });
    assert.equal(claimed.id, run.id);
    assert.match(claimed.lease_token, /^[0-9a-f-]{36}$/i);
    assert.equal(claimed.worker_id, workerId);
    assert.equal(claimed.case_timeout_ms, 60000);
    assert.ok(Date.parse(claimed.deadline_at) > Date.now());
    assert.ok(Date.parse(claimed.lease_expires_at) > Date.now());
    const publicRun = await repository.getRagEvalRunForUser(run.id, userId);
    assert.equal(publicRun.lease_token, undefined);
    assert.deepEqual(claimed.dataset.cases.map((item) => ({
      id: item.id,
      question: item.question,
      expected_answer: item.expected_answer,
      expected_keywords: item.expected_keywords,
      expected_source_files: item.expected_source_files,
      evaluation_spec: item.evaluation_spec,
    })), [
      {
        id: firstCaseId,
        question: 'original question one',
        expected_answer: 'answer one',
        expected_keywords: ['one'],
        expected_source_files: ['one.md'],
        evaluation_spec: { expected_chunk_ids: ['chunk-one'] },
      },
      {
        id: secondCaseId,
        question: 'original question two',
        expected_answer: 'answer two',
        expected_keywords: ['two'],
        expected_source_files: ['two.md'],
        evaluation_spec: { expected_answerable: false },
      },
    ]);

    const renewedUntil = await repository.renewRagEvalRunLease({
      runId: run.id,
      workerId,
      leaseToken: claimed.lease_token,
      leaseDurationMs: 60_000,
    });
    assert.ok(Date.parse(renewedUntil) > Date.now());
    await pool.query(
      `update rag_eval_runs
       set claimed_at = now() - interval '1 hour'
       where id = $1`,
      [run.id],
    );
    assert.equal(await repository.resetStaleRagEvalRunJobs(1000), 0);

    const completed = await repository.completeRagEvalRunWithResults({
      userId,
      runId: run.id,
      workerId,
      leaseToken: claimed.lease_token,
      output: successfulOutput(claimed.dataset.cases),
    });
    assert.equal(completed.status, 'completed');
    const linkedResults = await pool.query(
      `select question, case_id
       from rag_eval_results
       where run_id = $1
       order by question`,
      [run.id],
    );
    assert.deepEqual(linkedResults.rows, [
      { question: 'original question one', case_id: null },
      { question: 'original question two', case_id: secondCaseId },
    ]);
    const advancedPersistence = await pool.query(
      `select advanced_metrics
       from rag_eval_runs
       where id = $1`,
      [run.id],
    );
    assert.deepEqual(advancedPersistence.rows[0].advanced_metrics.latency_ms, {
      applicable: true,
      p50: 1,
      p95: 1,
      max: 1,
    });
    const advancedResult = await pool.query(
      `select advanced_metrics
       from rag_eval_results
       where run_id = $1
       order by question
       limit 1`,
      [run.id],
    );
    assert.equal(advancedResult.rows[0].advanced_metrics.answerability.accuracy, 1);

    const cancelledRun = await repository.createRunningRagEvalRunForUser({
      userId,
      datasetId,
      caseCount: 2,
    });
    await pool.query(
      `update rag_eval_runs
       set queued_at = now() - interval '100 years'
       where id = $1`,
      [cancelledRun.id],
    );
    const staleClaim = await repository.claimNextRagEvalRunJob({
      workerId: `${workerId}-stale`,
      retryBaseDelayMs: 1,
      staleAfterMs: 60_000,
      maxAttempts: 3,
    });
    assert.equal(staleClaim.id, cancelledRun.id);
    await pool.query(
      `update rag_eval_runs
       set lease_expires_at = now() - interval '1 second'
       where id = $1`,
      [cancelledRun.id],
    );
    assert.equal(await repository.resetStaleRagEvalRunJobs(1000), 1);
    const replacementClaim = await repository.claimNextRagEvalRunJob({
      workerId: `${workerId}-replacement`,
      retryBaseDelayMs: 1,
      staleAfterMs: 60_000,
      maxAttempts: 3,
    });
    assert.equal(replacementClaim.id, cancelledRun.id);
    assert.notEqual(replacementClaim.lease_token, staleClaim.lease_token);
    assert.equal(await repository.completeRagEvalRunWithResults({
      userId,
      runId: cancelledRun.id,
      workerId: `${workerId}-stale`,
      leaseToken: staleClaim.lease_token,
      output: successfulOutput(staleClaim.dataset.cases),
    }), null);
    assert.equal(await repository.markRagEvalRunAttemptFailed({
      run: staleClaim,
      workerId: `${workerId}-stale`,
      leaseToken: staleClaim.lease_token,
      errorMessage: 'RAG evaluation failed',
    }), null);

    const cancelled = await repository.cancelRagEvalRunForUser(cancelledRun.id, userId);
    assert.equal(cancelled.status, 'cancelled');
    const cancelledLease = await pool.query(
      `select lease_token, lease_expires_at
       from rag_eval_runs
       where id = $1`,
      [cancelledRun.id],
    );
    assert.deepEqual(cancelledLease.rows[0], {
      lease_token: null,
      lease_expires_at: null,
    });
    assert.equal(await repository.renewRagEvalRunLease({
      runId: cancelledRun.id,
      workerId: `${workerId}-replacement`,
      leaseToken: replacementClaim.lease_token,
      leaseDurationMs: 60_000,
    }), null);
    assert.equal(await repository.completeRagEvalRunWithResults({
      userId,
      runId: cancelledRun.id,
      workerId: `${workerId}-replacement`,
      leaseToken: replacementClaim.lease_token,
      output: successfulOutput(replacementClaim.dataset.cases),
    }), null);

    await pool.query(
      `insert into rag_eval_cases (dataset_id, user_id, question)
       select $1, $2, 'seed case ' || value::text
       from generate_series(1, 49) as value`,
      [limitedDatasetId, userId],
    );
    const concurrentCreates = await Promise.all([
      repository.createRagEvalCaseForUser({
        userId,
        datasetId: limitedDatasetId,
        question: 'concurrent case A',
        maxCases: 50,
      }),
      repository.createRagEvalCaseForUser({
        userId,
        datasetId: limitedDatasetId,
        question: 'concurrent case B',
        maxCases: 50,
      }),
    ]);
    assert.equal(concurrentCreates.filter(Boolean).length, 1);
    const finalCount = await pool.query(
      `select count(*)::integer as count
       from rag_eval_cases
       where dataset_id = $1`,
      [limitedDatasetId],
    );
    assert.equal(finalCount.rows[0].count, 50);
  } finally {
    await pool.query('delete from users where id = $1', [userId]).catch(() => undefined);
    try {
      await releaseIntegrationLock();
    } finally {
      await closeDatabasePool();
    }
  }
});

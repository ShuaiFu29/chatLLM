import type { PoolClient } from 'pg';
import { serverEnv } from '../lib/env';
import { query, withTransaction } from '../lib/db';
import type { AgentDryRunPlannedToolCall } from '../modules/agents/runtime/agent-dry-run';
import type { AgentTokenUsage } from '../modules/agents/runtime/agent-evidence';

export const AGENT_EVAL_EVALUATOR_VERSION = 'agent-eval-v1';
export const MAX_AGENT_EVAL_CASES_PER_DATASET = 100;
export const MAX_AGENT_EVAL_CASES_PER_RUN = 100;
export const MAX_AGENT_EVAL_DATASETS_PER_USER = 50;
export const MAX_ACTIVE_AGENT_EVAL_RUNS_PER_USER = 2;
export const MAX_AGENT_EVAL_RUNS_PER_USER = 1000;

export interface AgentEvalExpectedToolCall extends Record<string, unknown> {
  tool_key: string;
  arguments?: Record<string, unknown>;
  fixture?: unknown;
}

export interface AgentEvalEvaluationSpec extends Record<string, unknown> {
  expected_output_contains?: string[];
  forbidden_output_contains?: string[];
  expected_tool_calls?: AgentEvalExpectedToolCall[];
  forbidden_tool_keys?: string[];
  grounding_evidence?: string[];
  expected_citations?: string[];
}

export interface AgentEvalCaseRow {
  id: string;
  dataset_id: string;
  user_id: string;
  name: string;
  input_text: string;
  evaluation_spec: AgentEvalEvaluationSpec;
  created_at: string;
  updated_at: string;
}

export interface AgentEvalDatasetRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  revision: number | string;
  created_at: string;
  updated_at: string;
  cases?: AgentEvalCaseRow[];
  runs?: AgentEvalRunRow[];
}

export type AgentEvalRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface AgentEvalRunRow {
  id: string;
  user_id: string;
  dataset_id: string;
  dataset_revision: number | string;
  agent_id: string;
  candidate_agent_version_id: string;
  candidate_configuration_hash: string;
  baseline_agent_version_id: string | null;
  baseline_configuration_hash: string | null;
  evaluator_version: string;
  status: AgentEvalRunStatus;
  case_count: number;
  result_count: number;
  failed_result_count: number;
  aggregate_metrics: Record<string, unknown>;
  usage: AgentTokenUsage;
  validation_report: Record<string, unknown>;
  execution_snapshot: Record<string, unknown>;
  failure_code: string | null;
  failure_message: string | null;
  attempts: number;
  max_attempts: number;
  queued_at: string;
  next_attempt_at: string | null;
  claimed_at: string | null;
  worker_id: string | null;
  lease_token: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  deadline_at: string | null;
  created_at: string;
  completed_at: string | null;
  results?: AgentEvalResultRow[];
}

export interface AgentEvalRunCaseRow {
  run_id: string;
  case_id: string;
  ordinal: number;
  name: string;
  input_text: string;
  evaluation_spec: AgentEvalEvaluationSpec;
  case_created_at: string;
  case_updated_at: string;
  snapshotted_at: string;
}

export interface AgentEvalResultRow {
  id: string;
  run_id: string;
  case_id: string;
  variant: 'candidate' | 'baseline';
  agent_id: string;
  agent_version_id: string;
  configuration_hash: string;
  status: 'succeeded' | 'failed';
  output_text: string;
  planned_tool_calls: AgentDryRunPlannedToolCall[];
  metrics: Record<string, unknown>;
  usage: AgentTokenUsage;
  latency_ms: number;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
}

export interface ClaimedAgentEvalRun extends AgentEvalRunRow {
  worker_id: string;
  lease_token: string;
  deadline_at: string;
  cases: AgentEvalRunCaseRow[];
}

export interface AgentEvalResultInput {
  caseId: string;
  variant: 'candidate' | 'baseline';
  agentId: string;
  agentVersionId: string;
  configurationHash: string;
  status: 'succeeded' | 'failed';
  outputText: string;
  plannedToolCalls: AgentDryRunPlannedToolCall[];
  metrics: Record<string, unknown>;
  usage: AgentTokenUsage;
  latencyMs: number;
  failureCode?: string;
  failureMessage?: string;
}

const datasetColumns = `
  id, user_id, name, description, revision, created_at, updated_at
`;
const caseColumns = `
  id, dataset_id, user_id, name, input_text, evaluation_spec, created_at, updated_at
`;
const runColumns = `
  id, user_id, dataset_id, dataset_revision, agent_id,
  candidate_agent_version_id, candidate_configuration_hash,
  baseline_agent_version_id, baseline_configuration_hash,
  evaluator_version, status, case_count, result_count, failed_result_count,
  aggregate_metrics, usage, validation_report, execution_snapshot,
  failure_code, failure_message, attempts, max_attempts, queued_at,
  next_attempt_at, claimed_at, worker_id, lease_token, heartbeat_at,
  lease_expires_at, deadline_at, created_at, completed_at
`;

export const listAgentEvalDatasetsForUser = async (
  userId: string,
): Promise<AgentEvalDatasetRow[]> => {
  const [{ rows: datasets }, { rows: cases }, { rows: runs }] = await Promise.all([
    query<AgentEvalDatasetRow>(
      `select ${datasetColumns}
       from agent_eval_datasets
       where user_id = $1
       order by updated_at desc, id desc`,
      [userId],
    ),
    query<AgentEvalCaseRow>(
      `select ${caseColumns}
       from agent_eval_cases
       where user_id = $1
       order by created_at asc, id asc`,
      [userId],
    ),
    query<AgentEvalRunRow>(
      `select ${runColumns}
       from agent_eval_runs
       where user_id = $1
       order by created_at desc, id desc
       limit 200`,
      [userId],
    ),
  ]);
  const casesByDataset = new Map<string, AgentEvalCaseRow[]>();
  for (const item of cases) {
    casesByDataset.set(item.dataset_id, [...(casesByDataset.get(item.dataset_id) || []), item]);
  }
  const runsByDataset = new Map<string, AgentEvalRunRow[]>();
  for (const item of runs) {
    runsByDataset.set(item.dataset_id, [...(runsByDataset.get(item.dataset_id) || []), item]);
  }
  return datasets.map((dataset) => ({
    ...dataset,
    cases: casesByDataset.get(dataset.id) || [],
    runs: runsByDataset.get(dataset.id) || [],
  }));
};

export const createAgentEvalDatasetForUser = async (input: {
  userId: string;
  name: string;
  description: string;
}) => {
  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 7500))`, [input.userId]);
    const { rows: counts } = await client.query<{ count: string }>(
      `select count(*)::text as count from agent_eval_datasets where user_id = $1`,
      [input.userId],
    );
    if (Number(counts[0]?.count || 0) >= MAX_AGENT_EVAL_DATASETS_PER_USER) {
      throw new Error('AGENT_EVAL_DATASET_LIMIT');
    }
    const { rows } = await client.query<AgentEvalDatasetRow>(
      `insert into agent_eval_datasets (user_id, name, description)
       values ($1, $2, $3)
       returning ${datasetColumns}`,
      [input.userId, input.name, input.description],
    );
    return { ...rows[0], cases: [], runs: [] };
  });
};

export const deleteAgentEvalDatasetForUser = async (datasetId: string, userId: string) => (
  withTransaction(async (client) => {
    // Serialize deletion with Case/Run creation, both of which lock this row.
    // Capture active claims before the cascading delete so the API process can
    // abort its local model requests immediately after the transaction commits.
    const { rows: datasets } = await client.query<{ id: string }>(
      `select id
       from agent_eval_datasets
       where id = $1 and user_id = $2
       for update`,
      [datasetId, userId],
    );
    if (!datasets[0]) return { deleted: false, activeRunIds: [] as string[] };

    const { rows: activeRuns } = await client.query<{ id: string }>(
      `select id
       from agent_eval_runs
       where dataset_id = $1
         and user_id = $2
         and status in ('queued', 'running')
       for update`,
      [datasetId, userId],
    );
    await client.query(
      `delete from agent_eval_datasets where id = $1 and user_id = $2`,
      [datasetId, userId],
    );
    return {
      deleted: true,
      activeRunIds: activeRuns.map((run) => run.id),
    };
  })
);

export const createAgentEvalCaseForUser = async (input: {
  userId: string;
  datasetId: string;
  name: string;
  inputText: string;
  evaluationSpec: AgentEvalEvaluationSpec;
}) => withTransaction(async (client) => {
  const { rows: datasets } = await client.query<{ id: string }>(
    `select id
     from agent_eval_datasets
     where id = $1 and user_id = $2
     for update`,
    [input.datasetId, input.userId],
  );
  if (!datasets[0]) return null;
  const { rows: counts } = await client.query<{ count: string }>(
    `select count(*)::text as count
     from agent_eval_cases
     where dataset_id = $1 and user_id = $2`,
    [input.datasetId, input.userId],
  );
  if (Number(counts[0]?.count || 0) >= MAX_AGENT_EVAL_CASES_PER_DATASET) {
    throw new Error('AGENT_EVAL_CASE_LIMIT');
  }
  const { rows } = await client.query<AgentEvalCaseRow>(
    `insert into agent_eval_cases (
       dataset_id, user_id, name, input_text, evaluation_spec
     ) values ($1, $2, $3, $4, $5::jsonb)
     returning ${caseColumns}`,
    [
      input.datasetId,
      input.userId,
      input.name,
      input.inputText,
      JSON.stringify(input.evaluationSpec),
    ],
  );
  return rows[0];
});

export const deleteAgentEvalCaseForUser = async (caseId: string, userId: string) => {
  const { rows } = await query<{ id: string }>(
    `delete from agent_eval_cases
     where id = $1 and user_id = $2
     returning id`,
    [caseId, userId],
  );
  return Boolean(rows[0]);
};

export const createAgentEvalRunForUser = async (input: {
  userId: string;
  datasetId: string;
  agentId: string;
  candidateAgentVersionId: string;
  candidateConfigurationHash: string;
  baselineAgentVersionId?: string | null;
  baselineConfigurationHash?: string | null;
  validationReport: Record<string, unknown>;
  executionSnapshot: Record<string, unknown>;
}) => withTransaction(async (client) => {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 7501))`, [input.userId]);
  const { rows: datasets } = await client.query<AgentEvalDatasetRow>(
    `select ${datasetColumns}
     from agent_eval_datasets
     where id = $1 and user_id = $2
     for update`,
    [input.datasetId, input.userId],
  );
  const dataset = datasets[0];
  if (!dataset) return null;

  // Preserve idempotency before applying per-user quotas. A client may retry
  // the exact request after losing the HTTP response; the already queued or
  // running execution consumes no additional capacity and must remain
  // reusable even when the user's active/history quota is otherwise full.
  const { rows: existing } = await client.query<AgentEvalRunRow>(
    `select ${runColumns}
     from agent_eval_runs
     where user_id = $1
       and dataset_id = $2
       and dataset_revision = $3
       and agent_id = $4
       and candidate_agent_version_id = $5
       and baseline_agent_version_id is not distinct from $6::uuid
       and status in ('queued', 'running')
     order by created_at desc
     limit 1`,
    [
      input.userId,
      input.datasetId,
      dataset.revision,
      input.agentId,
      input.candidateAgentVersionId,
      input.baselineAgentVersionId || null,
    ],
  );
  if (existing[0]) return { ...existing[0], results: [], created: false as const };

  const { rows: runCounts } = await client.query<{ active_count: string; total_count: string }>(
    `select
       count(*) filter (where status in ('queued', 'running'))::text as active_count,
       count(*)::text as total_count
     from agent_eval_runs
     where user_id = $1`,
    [input.userId],
  );
  if (Number(runCounts[0]?.active_count || 0) >= MAX_ACTIVE_AGENT_EVAL_RUNS_PER_USER) {
    throw new Error('AGENT_EVAL_ACTIVE_RUN_LIMIT');
  }
  if (Number(runCounts[0]?.total_count || 0) >= MAX_AGENT_EVAL_RUNS_PER_USER) {
    throw new Error('AGENT_EVAL_RUN_HISTORY_LIMIT');
  }
  const { rows: cases } = await client.query<AgentEvalCaseRow>(
    `select ${caseColumns}
     from agent_eval_cases
     where dataset_id = $1 and user_id = $2
     order by created_at asc, id asc
     limit $3`,
    [input.datasetId, input.userId, MAX_AGENT_EVAL_CASES_PER_RUN + 1],
  );
  if (cases.length === 0) throw new Error('AGENT_EVAL_DATASET_EMPTY');
  if (cases.length > MAX_AGENT_EVAL_CASES_PER_RUN) throw new Error('AGENT_EVAL_RUN_CASE_LIMIT');

  const { rows } = await client.query<AgentEvalRunRow>(
    `insert into agent_eval_runs (
       user_id, dataset_id, dataset_revision, agent_id,
       candidate_agent_version_id, candidate_configuration_hash,
       baseline_agent_version_id, baseline_configuration_hash,
       evaluator_version, case_count, validation_report, execution_snapshot,
       max_attempts
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
     returning ${runColumns}`,
    [
      input.userId,
      input.datasetId,
      dataset.revision,
      input.agentId,
      input.candidateAgentVersionId,
      input.candidateConfigurationHash,
      input.baselineAgentVersionId || null,
      input.baselineConfigurationHash || null,
      AGENT_EVAL_EVALUATOR_VERSION,
      cases.length,
      JSON.stringify(input.validationReport),
      JSON.stringify(input.executionSnapshot),
      serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS,
    ],
  );
  const run = rows[0];
  for (const [ordinal, testCase] of cases.entries()) {
    await client.query(
      `insert into agent_eval_run_cases (
         run_id, case_id, ordinal, name, input_text, evaluation_spec,
         case_created_at, case_updated_at
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        run.id,
        testCase.id,
        ordinal,
        testCase.name,
        testCase.input_text,
        JSON.stringify(testCase.evaluation_spec || {}),
        testCase.created_at,
        testCase.updated_at,
      ],
    );
  }
  return { ...run, results: [], created: true as const };
});

export const getAgentEvalRunForUser = async (runId: string, userId: string) => {
  const { rows } = await query<AgentEvalRunRow>(
    `select ${runColumns}
     from agent_eval_runs
     where id = $1 and user_id = $2`,
    [runId, userId],
  );
  if (!rows[0]) return null;
  const { rows: results } = await query<AgentEvalResultRow>(
    `select *
     from agent_eval_results
     where run_id = $1
     order by case_id, case when variant = 'candidate' then 0 else 1 end`,
    [runId],
  );
  return { ...rows[0], results };
};

export const listDispatchableAgentEvalRunIds = async (limit = 50) => {
  const boundedLimit = Math.max(1, Math.min(500, limit));
  const { rows } = await query<{ id: string }>(
    `select id
     from agent_eval_runs
     where (
       status = 'queued'
       and (next_attempt_at is null or next_attempt_at <= now())
     ) or (
       status = 'running'
       and lease_expires_at <= now()
       and attempts < max_attempts
       and (deadline_at is null or deadline_at > now())
     )
     order by coalesce(next_attempt_at, queued_at), created_at
     limit $1`,
    [boundedLimit],
  );
  return rows.map((row) => row.id);
};

export const claimAgentEvalRunJobById = async (input: {
  runId: string;
  workerId: string;
  leaseDurationMs?: number;
  runTimeoutMs?: number;
}): Promise<ClaimedAgentEvalRun | null> => withTransaction(async (client) => {
  const leaseDurationMs = input.leaseDurationMs ?? serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS;
  const runTimeoutMs = input.runTimeoutMs ?? serverEnv.RAG_EVAL_RUN_TIMEOUT_MS;
  const { rows } = await client.query<AgentEvalRunRow>(
    `update agent_eval_runs
     set status = 'running',
         attempts = attempts + 1,
         claimed_at = now(),
         worker_id = $2,
         lease_token = gen_random_uuid(),
         heartbeat_at = now(),
         lease_expires_at = now() + ($3::double precision * interval '1 millisecond'),
         deadline_at = coalesce(deadline_at, now() + ($4::double precision * interval '1 millisecond')),
         next_attempt_at = null
     where id = $1
       and attempts < max_attempts
       and (
         (status = 'queued' and (next_attempt_at is null or next_attempt_at <= now()))
         or (
           status = 'running'
           and lease_expires_at <= now()
           and (deadline_at is null or deadline_at > now())
         )
       )
     returning ${runColumns}`,
    [input.runId, input.workerId, leaseDurationMs, runTimeoutMs],
  );
  const run = rows[0];
  if (!run?.worker_id || !run.lease_token || !run.deadline_at) return null;
  const { rows: cases } = await client.query<AgentEvalRunCaseRow>(
    `select *
     from agent_eval_run_cases
     where run_id = $1
     order by ordinal asc`,
    [run.id],
  );
  if (cases.length !== run.case_count) throw new Error('Agent eval run case snapshot is incomplete');
  return {
    ...run,
    worker_id: run.worker_id,
    lease_token: run.lease_token,
    deadline_at: run.deadline_at,
    cases,
  };
});

export const renewAgentEvalRunLease = async (input: {
  runId: string;
  workerId: string;
  leaseToken: string;
  leaseDurationMs?: number;
}) => {
  const leaseDurationMs = input.leaseDurationMs ?? serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS;
  const { rows } = await query<{ lease_expires_at: string }>(
    `update agent_eval_runs
     set heartbeat_at = now(),
         lease_expires_at = now() + ($4::double precision * interval '1 millisecond')
     where id = $1
       and status = 'running'
       and worker_id = $2
       and lease_token = $3
       and lease_expires_at > now()
       and deadline_at > now()
     returning lease_expires_at`,
    [input.runId, input.workerId, input.leaseToken, leaseDurationMs],
  );
  return rows[0]?.lease_expires_at || null;
};

export const completeAgentEvalRun = async (input: {
  runId: string;
  userId: string;
  workerId: string;
  leaseToken: string;
  status: Extract<AgentEvalRunStatus, 'completed' | 'partial' | 'failed'>;
  aggregateMetrics: Record<string, unknown>;
  usage: AgentTokenUsage;
  results: AgentEvalResultInput[];
  failureCode?: string;
  failureMessage?: string;
}) => withTransaction(async (client) => {
  const { rows: locked } = await client.query<AgentEvalRunRow>(
    `select ${runColumns}
     from agent_eval_runs
     where id = $1
       and user_id = $2
       and status = 'running'
       and worker_id = $3
       and lease_token = $4
       and lease_expires_at > now()
       and deadline_at > now()
     for update`,
    [input.runId, input.userId, input.workerId, input.leaseToken],
  );
  if (!locked[0]) return null;

  await client.query(`delete from agent_eval_results where run_id = $1`, [input.runId]);
  for (const result of input.results) {
    await client.query(
      `insert into agent_eval_results (
         run_id, case_id, variant, agent_id, agent_version_id, configuration_hash,
         status, output_text, planned_tool_calls, metrics, usage, latency_ms,
         failure_code, failure_message
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
         $12, $13, $14
       )`,
      [
        input.runId,
        result.caseId,
        result.variant,
        result.agentId,
        result.agentVersionId,
        result.configurationHash,
        result.status,
        result.outputText,
        JSON.stringify(result.plannedToolCalls),
        JSON.stringify(result.metrics),
        JSON.stringify(result.usage),
        result.latencyMs,
        result.failureCode || null,
        result.failureMessage || null,
      ],
    );
  }
  const failedResultCount = input.results.filter((result) => result.status === 'failed').length;
  const { rows } = await client.query<AgentEvalRunRow>(
    `update agent_eval_runs
     set status = $5,
         result_count = $6,
         failed_result_count = $7,
         aggregate_metrics = $8::jsonb,
         usage = $9::jsonb,
         failure_code = $10,
         failure_message = $11,
         claimed_at = null,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         next_attempt_at = null,
         heartbeat_at = now(),
         completed_at = now()
     where id = $1 and user_id = $2 and worker_id = $3 and lease_token = $4
     returning ${runColumns}`,
    [
      input.runId,
      input.userId,
      input.workerId,
      input.leaseToken,
      input.status,
      input.results.length,
      failedResultCount,
      JSON.stringify(input.aggregateMetrics),
      JSON.stringify(input.usage),
      input.status === 'failed' ? input.failureCode || 'agent_eval_failed' : null,
      input.status === 'failed' ? input.failureMessage || 'Agent evaluation failed' : null,
    ],
  );
  return rows[0] ? { ...rows[0], results: input.results } : null;
});

export const markAgentEvalRunAttemptFailed = async (input: {
  run: ClaimedAgentEvalRun;
  workerId: string;
  leaseToken: string;
  errorMessage: string;
}) => {
  const exhausted = input.run.attempts >= input.run.max_attempts
    || new Date(input.run.deadline_at).getTime() <= Date.now();
  const retryDelayMs = Math.min(
    60 * 60 * 1000,
    serverEnv.RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, input.run.attempts - 1),
  );
  const { rows } = await query<AgentEvalRunRow>(
    `update agent_eval_runs
     set status = case when $5 then 'failed' else 'queued' end,
         failure_code = case when $5 then 'agent_eval_failed' else null end,
         failure_message = case when $5 then $6 else null end,
         claimed_at = null,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         heartbeat_at = now(),
         next_attempt_at = case
           when $5 then null
           else now() + ($7::double precision * interval '1 millisecond')
         end,
         completed_at = case when $5 then now() else null end
     where id = $1
       and user_id = $2
       and status = 'running'
       and worker_id = $3
       and lease_token = $4
     returning ${runColumns}`,
    [
      input.run.id,
      input.run.user_id,
      input.workerId,
      input.leaseToken,
      exhausted,
      input.errorMessage,
      retryDelayMs,
    ],
  );
  return rows[0] || null;
};

export const cancelAgentEvalRunForUser = async (runId: string, userId: string) => {
  const { rows } = await query<AgentEvalRunRow>(
    `update agent_eval_runs
     set status = 'cancelled',
         claimed_at = null,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         next_attempt_at = null,
         heartbeat_at = now(),
         completed_at = now()
     where id = $1 and user_id = $2 and status in ('queued', 'running')
     returning ${runColumns}`,
    [runId, userId],
  );
  return rows[0] ? { ...rows[0], results: [] } : null;
};

export const cancelActiveAgentEvalRunsForAgentWithClient = async (
  client: PoolClient,
  agentId: string,
  userId: string,
) => {
  const { rows } = await client.query<{ id: string }>(
    `update agent_eval_runs
     set status = 'cancelled',
         claimed_at = null,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         next_attempt_at = null,
         heartbeat_at = now(),
         completed_at = now()
     where agent_id = $1
       and user_id = $2
       and status in ('queued', 'running')
     returning id`,
    [agentId, userId],
  );
  return rows.map((row) => row.id);
};

export const isAgentEvalRunClaimActive = async (input: {
  runId: string;
  workerId: string;
  leaseToken: string;
}) => {
  const { rows } = await query<{ active: boolean }>(
    `select exists (
       select 1
       from agent_eval_runs
       where id = $1
         and status = 'running'
         and worker_id = $2
         and lease_token = $3
         and lease_expires_at > now()
         and deadline_at > now()
     ) as active`,
    [input.runId, input.workerId, input.leaseToken],
  );
  return rows[0]?.active === true;
};

export const resetStaleAgentEvalRuns = async () => {
  const { rowCount } = await query(
    `update agent_eval_runs
     set status = 'queued',
         claimed_at = null,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         next_attempt_at = now(),
         heartbeat_at = now()
     where status = 'running'
       and lease_expires_at <= now()
       and deadline_at > now()
       and attempts < max_attempts`,
  );
  return rowCount || 0;
};

export const failExpiredAgentEvalRuns = async () => {
  const { rowCount } = await query(
    `update agent_eval_runs
     set status = 'failed',
         failure_code = 'agent_eval_timeout',
         failure_message = 'Agent evaluation exceeded its durable deadline',
         claimed_at = null,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         next_attempt_at = null,
         heartbeat_at = now(),
         completed_at = now()
     where status in ('queued', 'running')
       and (
         (deadline_at is not null and deadline_at <= now())
         or attempts >= max_attempts
       )`,
  );
  return rowCount || 0;
};

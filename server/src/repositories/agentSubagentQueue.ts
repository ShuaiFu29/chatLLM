import { query } from '../lib/db';
import { runColumns, type AgentRunRow } from './agentRuns';

/**
 * Claiming and reporting on dispatched subagent runs.
 *
 * A dispatched run is a durable queue entry. The parent normally claims its own
 * children straight away, which keeps the common case as fast as an in-process
 * call, but the row is what survives a restart -- and because the parent reads
 * outcomes back from the database rather than from a returned value, the path is
 * identical whether the child ran here or on another instance.
 */



export interface ClaimedSubagentRun extends AgentRunRow {
  // Narrowed: a claimed run always holds a lease.
  lease_token: string;
  lease_expires_at: string;
}

/**
 * Take ownership of one specific queued child.
 *
 * Scoped to a single id rather than "the next queued row" for the parent's own
 * fast path: a parent must not accidentally pick up a sibling tree's work, and
 * `skip locked` keeps two claimers from fighting over the same row.
 */
export const claimQueuedSubagentRun = async (input: {
  runId: string;
  leaseDurationMs: number;
}) => {
  const { rows } = await query<ClaimedSubagentRun>(
    `update agent_runs
     set status = 'running',
         started_at = coalesce(started_at, now()),
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + ($2::double precision * interval '1 millisecond')
     where id = (
       select id from agent_runs
       where id = $1
         and status = 'queued'
         and parent_run_id is not null
       for update skip locked
     )
     returning ${runColumns}`,
    [input.runId, input.leaseDurationMs],
  );
  return rows[0] || null;
};

/**
 * Claim the oldest queued child left behind by a process that died. Used by the
 * sweeper, not by a dispatching parent.
 */
export const claimAbandonedSubagentRun = async (input: {
  leaseDurationMs: number;
  abandonedBeforeMs: number;
}) => {
  const { rows } = await query<ClaimedSubagentRun>(
    `update agent_runs
     set status = 'running',
         started_at = coalesce(started_at, now()),
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + ($1::double precision * interval '1 millisecond')
     where id = (
       select id from agent_runs
       where status = 'queued'
         and parent_run_id is not null
         and queued_at < now() - ($2::double precision * interval '1 millisecond')
       order by queued_at
       for update skip locked
       limit 1
     )
     returning ${runColumns}`,
    [input.leaseDurationMs, input.abandonedBeforeMs],
  );
  return rows[0] || null;
};

export const renewSubagentRunLease = async (input: {
  runId: string;
  leaseToken: string;
  leaseDurationMs: number;
}) => {
  const { rows } = await query<{ lease_expires_at: string }>(
    `update agent_runs
     set lease_expires_at = now() + ($3::double precision * interval '1 millisecond')
     where id = $1 and lease_token = $2 and status = 'running'
     returning lease_expires_at`,
    [input.runId, input.leaseToken, input.leaseDurationMs],
  );
  return rows[0]?.lease_expires_at || null;
};

export const releaseSubagentRunLease = async (input: {
  runId: string;
  leaseToken: string;
}) => {
  await query(
    `update agent_runs
     set lease_token = null, lease_expires_at = null
     where id = $1 and lease_token = $2`,
    [input.runId, input.leaseToken],
  );
};

/**
 * Fail dispatched runs whose holder stopped renewing.
 *
 * Deliberately a failure rather than a re-queue. A child's progress through its
 * own tool calls is not checkpointed, so restarting it could repeat a side effect
 * that already happened -- the same reason tool calls are only retried for
 * transport errors. The parent sees a failed subtask and can report it honestly.
 */
export const failExpiredSubagentRunLeases = async () => {
  const { rows } = await query<{ id: string }>(
    `update agent_runs
     set status = 'failed',
         error_code = 'subagent_lease_expired',
         error_message = 'The worker executing this subtask stopped responding',
         completed_at = now(),
         lease_token = null,
         lease_expires_at = null
     where parent_run_id is not null
       and status = 'running'
       and lease_expires_at is not null
       and lease_expires_at <= now()
     returning id`,
  );
  return rows.map((row) => row.id);
};

export interface SubagentRunOutcomeRow {
  id: string;
  agent_id: string | null;
  status: AgentRunRow['status'];
  error_code?: string | null;
  error_message?: string | null;
  iteration_count: number;
  tool_call_count: number;
  started_at?: string | null;
  completed_at?: string | null;
  parent_tool_call_id?: string | null;
  answer?: string | null;
}

/**
 * Read back everything one dispatch produced.
 *
 * The answer comes from the child's own `assistant` step rather than from a
 * message row, because a subagent deliberately writes no conversation message.
 * Reading it here is what lets the parent stay indifferent to which process
 * executed the child.
 */
export const listSubagentOutcomesForToolCall = async (input: {
  parentRunId: string;
  parentToolCallId: string;
  userId: string;
}) => {
  const { rows } = await query<SubagentRunOutcomeRow>(
    `select
       run.id,
       run.agent_id,
       run.status,
       run.error_code,
       run.error_message,
       run.iteration_count,
       run.tool_call_count,
       run.started_at,
       run.completed_at,
       run.parent_tool_call_id,
       (
         select step.content
         from agent_steps step
         where step.run_id = run.id
           and step.kind = 'assistant'
           and step.status = 'succeeded'
         order by step.sequence desc
         limit 1
       ) as answer
     from agent_runs run
     where run.parent_run_id = $1
       and run.parent_tool_call_id = $2
       and run.user_id = $3
     order by run.queued_at, run.created_at`,
    [input.parentRunId, input.parentToolCallId, input.userId],
  );
  return rows;
};

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export const areSubagentOutcomesTerminal = (outcomes: SubagentRunOutcomeRow[]) => (
  outcomes.length > 0 && outcomes.every((outcome) => TERMINAL_STATUSES.has(outcome.status))
);

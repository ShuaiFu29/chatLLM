import type { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';
import { RECOVERABLE_EXPIRED_AGENT_WORK_ITEM_SQL } from './agentRecoverySql';
import { runColumns, type AgentRunRow } from './agentRuns';
import { appendAgentRunEventWithClient } from './agentRunEvents';

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
     where id = $1 and lease_token = $2
       and status in ('running', 'waiting_subagent')
     returning lease_expires_at`,
    [input.runId, input.leaseToken, input.leaseDurationMs],
  );
  return rows[0]?.lease_expires_at || null;
};

/**
 * A delegated worker remains the only owner while it waits for grandchildren.
 * The lease token fences these transitions so a stale process cannot park or
 * resume a Run whose ownership has already ended.
 */
export const markClaimedSubagentRunWaitingForSubagents = async (input: {
  runId: string;
  leaseToken: string;
}) => {
  const { rows } = await query<AgentRunRow>(
    `update agent_runs
     set status = 'waiting_subagent'
     where id = $1 and lease_token = $2 and status = 'running'
     returning ${runColumns}`,
    [input.runId, input.leaseToken],
  );
  return rows[0] || null;
};

export const resumeClaimedSubagentRunFromSubagents = async (input: {
  runId: string;
  leaseToken: string;
}) => {
  const { rows } = await query<AgentRunRow>(
    `update agent_runs
     set status = 'running'
     where id = $1 and lease_token = $2 and status = 'waiting_subagent'
     returning ${runColumns}`,
    [input.runId, input.leaseToken],
  );
  return rows[0] || null;
};

export const releaseSubagentRunLease = async (input: {
  runId: string;
  leaseToken: string;
}) => {
  const { rowCount } = await query(
    `update agent_runs
     set lease_token = null, lease_expires_at = null
     where id = $1 and lease_token = $2
       and status in ('succeeded', 'failed', 'cancelled')`,
    [input.runId, input.leaseToken],
  );
  return (rowCount ?? 0) > 0;
};

export type ClaimedSubagentTerminalStatus = Extract<
  AgentRunRow['status'],
  'succeeded' | 'failed' | 'cancelled'
>;

/** Wake each parked parent exactly when the last child in its dispatch ends. */
const wakeParentsWithTerminalSubagents = async (
  client: PoolClient,
  childRunIds: string[],
) => {
  if (childRunIds.length === 0) return;
  await client.query(
    `with dispatches as (
       select distinct child.parent_run_id, child.parent_tool_call_id
       from agent_runs child
       where child.id = any($1::uuid[])
         and child.parent_run_id is not null
         and child.parent_tool_call_id is not null
     )
     update agent_work_items work
     set status = 'queued', available_at = now(), updated_at = now()
     from dispatches, agent_run_checkpoints checkpoint, agent_runs parent
     where work.run_id = dispatches.parent_run_id
       and work.status = 'waiting'
       and parent.id = dispatches.parent_run_id
       and parent.status = 'waiting_subagent'
       and checkpoint.run_id = work.run_id
       and checkpoint.boundary = 'subagents_wait'
       and checkpoint.payload #>> '{pending,toolCallId}' = dispatches.parent_tool_call_id
       and not exists (
         select 1
         from agent_runs sibling
         where sibling.parent_run_id = dispatches.parent_run_id
           and sibling.parent_tool_call_id = dispatches.parent_tool_call_id
           and sibling.status not in ('succeeded', 'failed', 'cancelled')
       )`,
    [childRunIds],
  );
};

/**
 * Commit a child outcome only while this worker still owns its lease.
 *
 * The lease token is a fencing token, not just a heartbeat. A worker that was
 * paused beyond its lease can wake up after maintenance has failed the Run; a
 * plain `update by id` would then let that stale worker overwrite the durable
 * outcome. Closing the Run, its active steps and any bubbled approval in one
 * transaction gives the child exactly one terminal edge.
 */
export const finalizeClaimedSubagentRun = async (input: {
  runId: string;
  leaseToken: string;
  status: ClaimedSubagentTerminalStatus;
  iterationCount: number;
  toolCallCount: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  assistant?: {
    sequence: number;
    content: string;
    output?: unknown;
    parentSpanId?: string | null;
  };
  tokenUsage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  grounding?: Record<string, unknown>;
}) => {
  if (input.assistant) {
    const payloadBytes = Buffer.byteLength(input.assistant.content, 'utf8')
      + (input.assistant.output === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(input.assistant.output), 'utf8'));
    if (payloadBytes > serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES) {
      throw new Error('Agent step payload exceeded its size limit');
    }
  }
  return withTransaction(async (client) => {
  // Lock the tree root as well as the claimed Run. `createSubagentRun` takes
  // the same root lock before inserting, so terminalization and nested
  // dispatch have a single ordering even when they happen on different
  // processes.
  const { rows: ownedRows } = await client.query<AgentRunRow>(
    `select run.*
     from agent_runs run
     join agent_runs root on root.id = run.root_run_id
     join agent_work_items work on work.run_id = run.id
     where run.id = $1 and run.lease_token = $2
       and run.lease_expires_at > now()
       and run.status in ('running', 'waiting_subagent')
       and work.status = 'running'
       and work.lease_token = $2
       and work.lease_expires_at > now()
     for update of root, run, work`,
    [input.runId, input.leaseToken],
  );
  if (!ownedRows[0]) return null;

  const { rows } = await client.query<AgentRunRow>(
    `update agent_runs
     set status = $3,
         iteration_count = $4,
         tool_call_count = $5,
         error_code = $6,
         error_message = $7,
         token_usage = $8,
         grounding = $9,
         completed_at = now(),
         lease_token = null,
         lease_expires_at = null
     where id = $1
       and lease_token = $2
       and lease_expires_at > now()
       and status in ('running', 'waiting_subagent')
     returning ${runColumns}`,
    [
      input.runId,
      input.leaseToken,
      input.status,
      input.iterationCount,
      input.toolCallCount,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      JSON.stringify(input.tokenUsage ?? {}),
      input.grounding ? JSON.stringify(input.grounding) : null,
    ],
  );
  const run = rows[0] || null;
  if (!run) return null;

  const { rows: endedDescendants } = await client.query<{ id: string }>(
    `with recursive descendants as (
       select child.id from agent_runs child where child.parent_run_id = $1
       union all
       select child.id
       from agent_runs child
       join descendants parent on child.parent_run_id = parent.id
     )
     update agent_runs child
     set status = 'cancelled', completed_at = now(),
         error_code = 'agent_run_parent_ended',
         error_message = 'Parent Agent run ended',
         lease_token = null, lease_expires_at = null
     where child.id in (select id from descendants)
       and child.user_id = $2
       and child.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
     returning child.id`,
    [input.runId, run.user_id],
  );
  const closedRunIds = [input.runId, ...endedDescendants.map((descendant) => descendant.id)];

  const { rowCount: closedWorkItemCount } = await client.query(
    `update agent_work_items work
     set status = case when work.run_id = $1 then $2 else 'cancelled' end,
         error_code = case when work.run_id = $1 then $3 else 'agent_run_parent_ended' end,
         error_message = case when work.run_id = $1 then $4 else 'Parent Agent run ended' end,
         completed_at = now(), lease_token = null, lease_expires_at = null, updated_at = now()
     where work.run_id = any($5::uuid[])
       and work.status in ('queued', 'running', 'waiting')
       and (work.run_id <> $1 or work.lease_token = $6)`,
    [
      input.runId,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      closedRunIds,
      input.leaseToken,
    ],
  );
  if ((closedWorkItemCount ?? 0) < 1) {
    throw new Error('AGENT_SUBAGENT_WORK_ITEM_FINALIZE_CONFLICT');
  }

  if (input.assistant) {
    await client.query(
      `insert into agent_steps (
         run_id, trace_id, parent_span_id, sequence, kind, status, content, output
       ) values ($1, $2, $3, $4, 'assistant', 'succeeded', $5, $6)`,
      [
        input.runId,
        run.root_run_id,
        input.assistant.parentSpanId ?? null,
        input.assistant.sequence,
        input.assistant.content,
        input.assistant.output === undefined
          ? null
          : JSON.stringify(input.assistant.output),
      ],
    );
  }

  const terminalReason = input.errorMessage
    || (input.status === 'succeeded' ? 'Subagent run completed' : 'Subagent run ended');
  const { rows: expiredApprovals } = await client.query<{ step_id: string | null }>(
    `update agent_approvals
     set status = 'expired', decided_at = now(), reason = $2
     where status = 'pending'
       and (run_id = any($1::uuid[]) or requested_by_run_id = any($1::uuid[]))
     returning step_id`,
    [closedRunIds, terminalReason],
  );
  const approvalStepIds = expiredApprovals
    .map((approval) => approval.step_id)
    .filter((stepId): stepId is string => Boolean(stepId));
  if (approvalStepIds.length > 0) {
    await client.query(
      `update agent_steps
       set status = 'failed',
           output = coalesce(output, '{}'::jsonb)
             || jsonb_build_object('decision', 'expired', 'reason', $2::text)
       where id = any($1::uuid[])
         and run_id = any($3::uuid[])
         and status in ('pending', 'running')`,
      [approvalStepIds, terminalReason, closedRunIds],
    );
  }
  const stepStatus = input.status === 'succeeded'
    ? 'succeeded'
    : input.status === 'cancelled' ? 'cancelled' : 'failed';
  await client.query(
    `update agent_steps
     set status = case when run_id = $1 then $2 else 'cancelled' end,
         output = case
           when $3::text is null then output
           else coalesce(output, '{}'::jsonb) || jsonb_build_object('reason', $3::text)
         end
     where run_id = any($4::uuid[]) and status in ('pending', 'running')`,
    [input.runId, stepStatus, input.errorMessage ?? null, closedRunIds],
  );
  const eventType = input.status === 'succeeded'
    ? 'subagent.completed'
    : 'subagent.failed';
  await appendAgentRunEventWithClient(client, {
    runId: input.runId,
    userId: run.user_id,
    eventKey: eventType,
    payload: {
      agentRunId: input.runId,
      agentEvent: {
        type: eventType,
        runId: input.runId,
        iterationCount: input.iterationCount,
        toolCallCount: input.toolCallCount,
        ...(input.errorMessage ? { error: input.errorMessage } : {}),
      },
    },
  });
  await wakeParentsWithTerminalSubagents(client, closedRunIds);
  return run;
  });
};

/**
 * Fail dispatched runs whose holder stopped renewing.
 *
 * Deliberately a failure rather than a blind re-queue. Recovery is owned by the
 * durable Work Item worker; this fallback sweeper must leave a run alone when
 * its final answer is already checkpointed and only the fenced terminal commit
 * remains. Other boundaries are failed until their replay rules are supported.
 */
export const failExpiredSubagentRunLeases = async () => {
  return withTransaction(async (client) => {
    const reason = 'The worker executing this subtask stopped responding';
    const { rows } = await client.query<{ id: string; status: AgentRunRow['status'] }>(
      `with recursive expired as (
         select id
         from agent_runs
         where parent_run_id is not null
           and status in ('running', 'waiting_subagent')
           and lease_expires_at is not null
           and lease_expires_at <= now()
           and not exists (
             select 1
             from agent_work_items work
             left join agent_run_checkpoints checkpoint on checkpoint.run_id = work.run_id
             left join agent_model_invocations invocation
               on invocation.run_id = work.run_id
              and invocation.id::text = checkpoint.payload #>> '{modelInvocation,invocationId}'
             where work.run_id = agent_runs.id
               and work.status = 'running'
               and work.lease_expires_at <= now()
               and ${RECOVERABLE_EXPIRED_AGENT_WORK_ITEM_SQL}
           )
       ), subtree as (
         select id, true as lease_expired from expired
         union
         select child.id, false
         from agent_runs child
         join subtree parent on child.parent_run_id = parent.id
       )
       update agent_runs run
       set status = case
             when run.id in (select id from expired) then 'failed'
             else 'cancelled'
           end,
           error_code = case
             when run.id in (select id from expired) then 'subagent_lease_expired'
             else 'agent_run_parent_ended'
           end,
           error_message = case
             when run.id in (select id from expired) then $1
             else 'Parent Agent run lease expired'
           end,
           completed_at = now(),
           lease_token = null,
           lease_expires_at = null
       where run.id in (select id from subtree)
         and run.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
       returning run.id, run.status`,
      [reason],
    );
    if (rows.length === 0) return [];
    const runIds = rows.map((row) => row.id);
    const { rows: expiredApprovals } = await client.query<{ step_id: string | null }>(
      `update agent_approvals
       set status = 'expired', decided_at = now(), reason = $2
       where status = 'pending'
         and (run_id = any($1::uuid[]) or requested_by_run_id = any($1::uuid[]))
       returning step_id`,
      [runIds, reason],
    );
    const approvalStepIds = expiredApprovals
      .map((approval) => approval.step_id)
      .filter((stepId): stepId is string => Boolean(stepId));
    if (approvalStepIds.length > 0) {
      await client.query(
        `update agent_steps
         set status = 'failed',
             output = coalesce(output, '{}'::jsonb)
               || jsonb_build_object('decision', 'expired', 'reason', $2::text)
         where id = any($1::uuid[])
           and run_id = any($3::uuid[])
           and status in ('pending', 'running')`,
        [approvalStepIds, reason, runIds],
      );
    }
    await client.query(
      `update agent_steps
       set status = case
             when run_id = any($3::uuid[]) then 'failed'
             else 'cancelled'
           end,
           output = coalesce(output, '{}'::jsonb)
             || jsonb_build_object('reason', $2::text)
       where run_id = any($1::uuid[]) and status in ('pending', 'running')`,
      [runIds, reason, rows.filter((row) => row.status === 'failed').map((row) => row.id)],
    );
    await client.query(
      `update agent_work_items work
       set status = case
             when work.run_id = any($2::uuid[]) then 'failed'
             else 'cancelled'
           end,
           error_code = case
             when work.run_id = any($2::uuid[]) then 'subagent_lease_expired'
             else 'agent_run_parent_ended'
           end,
           error_message = $3,
           completed_at = now(), lease_token = null, lease_expires_at = null, updated_at = now()
       where work.run_id = any($1::uuid[])
         and work.status in ('queued', 'running', 'waiting')`,
      [
        runIds,
        rows.filter((row) => row.status === 'failed').map((row) => row.id),
        reason,
      ],
    );
    await wakeParentsWithTerminalSubagents(client, runIds);
    return runIds;
  });
};

export interface SubagentRunOutcomeRow {
  id: string;
  task_index?: number | null;
  agent_id: string | null;
  status: AgentRunRow['status'];
  error_code?: string | null;
  error_message?: string | null;
  iteration_count: number;
  tool_call_count: number;
  started_at?: string | null;
  completed_at?: string | null;
  parent_tool_call_id?: string | null;
  token_usage: Record<string, number>;
  grounding?: Record<string, unknown> | null;
  answer?: string | null;
  result_envelope?: unknown;
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
       work.task_index,
       run.agent_id,
       run.status,
       run.error_code,
       run.error_message,
       run.iteration_count,
       run.tool_call_count,
       run.started_at,
       run.completed_at,
       run.parent_tool_call_id,
       run.token_usage,
       run.grounding,
       (
         select step.content
         from agent_steps step
         where step.run_id = run.id
           and step.kind = 'assistant'
           and step.status = 'succeeded'
         order by step.sequence desc
         limit 1
       ) as answer
       ,(
         select step.output
         from agent_steps step
         where step.run_id = run.id
           and step.kind = 'assistant'
           and step.status = 'succeeded'
         order by step.sequence desc
         limit 1
       ) as result_envelope
     from agent_runs run
     left join agent_work_items work on work.run_id = run.id
     where run.parent_run_id = $1
       and run.parent_tool_call_id = $2
       and run.user_id = $3
     order by work.task_index nulls last, run.queued_at, run.created_at, run.id`,
    [input.parentRunId, input.parentToolCallId, input.userId],
  );
  return rows;
};

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export const areSubagentOutcomesTerminal = (outcomes: SubagentRunOutcomeRow[]) => (
  outcomes.length > 0 && outcomes.every((outcome) => TERMINAL_STATUSES.has(outcome.status))
);

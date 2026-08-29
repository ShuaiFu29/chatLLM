import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';
import type { AgentApprovalIntent } from '../modules/agents/runtime/agent-approval-intent';
import {
  encodeAgentApprovalCursor,
  type AgentApprovalCursor,
} from '../lib/agentApprovalCursor';
import { serverEnv } from '../lib/env';
import { RECOVERABLE_EXPIRED_AGENT_WORK_ITEM_SQL } from './agentRecoverySql';
import { insertAgentWorkItem } from './agentWorkItems';
import { appendAgentRunEventWithClient } from './agentRunEvents';
import { recordAgentMemoryRecallsWithClient } from './agentMemories';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  // A parent Run blocked on its dispatched subagents. The previous flat state
  // machine could not express "waiting on a child that is itself waiting for a
  // human approval".
  | 'waiting_subagent'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type AgentStepKind =
  | 'model'
  | 'tool_call'
  | 'tool_result'
  | 'approval'
  | 'assistant'
  // Runtime decisions that used to leave no trace at all.
  | 'plan'
  | 'memory_read'
  | 'memory_write'
  | 'context_evicted'
  | 'budget_check'
  | 'subagent_dispatch'
  | 'subagent_result'
  // The resolved approval policy and the tools it withheld from the model.
  | 'tool_policy';
export type AgentStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'rejected';

const ACTIVE_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'waiting_subagent',
] as const;
// The literal list was previously inlined into eleven separate statements. Adding
// a state meant finding all eleven, and missing one would leave Runs in that
// state invisible to cancellation or stale recovery. Derive the SQL fragment so
// the set has exactly one definition.
const ACTIVE_RUN_STATUS_SQL = ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(', ');
export const activeRunStatusPredicate = (column = 'status') => `${column} in (${ACTIVE_RUN_STATUS_SQL})`;
const ACTIVE_STEP_STATUSES = ['pending', 'running'] as const;
// A maintenance tick must not fail a healthy run at the exact end of its
// configured model/tool deadline. The grace also covers a slow database tick
// and the final transaction that persists the assistant message.
const STALE_RECOVERY_GRACE_MS = 60_000;
const PRE_RUN_CANCELLATION_TTL_MS = 30_000;

export interface AgentRunRow {
  id: string;
  user_id: string;
  agent_id?: string | null;
  agent_version_id?: string | null;
  conversation_id: string;
  user_message_id?: string | null;
  assistant_message_id?: string | null;
  status: AgentRunStatus;
  root_run_id: string;
  parent_run_id?: string | null;
  parent_tool_call_id?: string | null;
  depth: number;
  ancestor_agent_ids: string[];
  /** Set when this run was enqueued as dispatched work. Null for a root run. */
  queued_at?: string | null;
  /** Held by the worker currently executing this dispatched run. */
  lease_token?: string | null;
  lease_expires_at?: string | null;
  iteration_count: number;
  tool_call_count: number;
  token_usage: Record<string, number>;
  grounding?: Record<string, unknown> | null;
  agent_version_snapshot: Record<string, unknown>;
  error_code?: string | null;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
}

export interface AgentStepRow {
  id: string;
  run_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  sequence: number;
  kind: AgentStepKind;
  status: AgentStepStatus;
  tool_call_id?: string | null;
  tool_key?: string | null;
  input?: unknown;
  output?: unknown;
  content?: string | null;
  duration_ms?: number | null;
  created_at: string;
}

export interface AgentApprovalRow {
  id: string;
  run_id: string;
  step_id?: string | null;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reason: string;
  expires_at: string;
  decided_at?: string | null;
  /** Set when a dispatched subagent asked and the decision surfaces on the root. */
  requested_by_run_id?: string | null;
  intent: AgentApprovalIntent;
  intent_hash: string;
  /** Runtime projection used by the root timeline for bubbled child approvals. */
  requested_by_agent_id?: string | null;
  requested_by_agent_name?: string | null;
  requested_by_depth?: number | null;
  requested_by_parent_run_id?: string | null;
  tool_call_id?: string | null;
  tool_key?: string | null;
  input?: unknown;
  output?: unknown;
  created_at: string;
}

export interface AgentRunDetail extends AgentRunRow {
  steps: AgentStepRow[];
  approvals: AgentApprovalRow[];
  steps_has_more: boolean;
  approvals_has_more: boolean;
}

export const runColumns = `
  id,
  user_id,
  agent_id,
  agent_version_id,
  conversation_id,
  user_message_id,
  assistant_message_id,
  status,
  root_run_id,
  parent_run_id,
  parent_tool_call_id,
  depth,
  ancestor_agent_ids,
  queued_at,
  lease_token,
  lease_expires_at,
  iteration_count,
  tool_call_count,
  token_usage,
  grounding,
  agent_version_snapshot,
  error_code,
  error_message,
  started_at,
  completed_at,
  created_at
`;

const stepColumns = `
  id,
  run_id,
  trace_id,
  span_id,
  parent_span_id,
  sequence,
  kind,
  status,
  tool_call_id,
  tool_key,
  input,
  output,
  content,
  duration_ms,
  created_at
`;

const approvalColumns = `
  id,
  run_id,
  step_id,
  user_id,
  status,
  reason,
  expires_at,
  decided_at,
  requested_by_run_id,
  intent,
  intent_hash,
  created_at
`;

const stepColumnsWithAlias = `
  step.id,
  step.run_id,
  step.trace_id,
  step.span_id,
  step.parent_span_id,
  step.sequence,
  step.kind,
  step.status,
  step.tool_call_id,
  step.tool_key,
  step.input,
  step.output,
  step.content,
  step.duration_ms,
  step.created_at
`;

export const createAgentRun = async (input: {
  userId: string;
  agentId: string;
  agentVersionId: string;
  conversationId: string;
  userMessageId: string;
  agentVersionSnapshot: Record<string, unknown>;
  workItemPayload?: Record<string, unknown>;
  recalledMemoryIds?: readonly string[];
  budget: {
    deadlineAt: Date;
    tokenTotal: number;
    iterationTotal: number;
    toolCallTotal: number;
    subagentDispatchTotal: number;
    finalAnswerReserveTokens: number;
  };
}) => {
  const run = await withTransaction(async (client) => {
    // Serialize creation with a stop request for this exact user message. A
    // cancellation intent is committed before returning from the cancel API;
    // deleting it here consumes precisely one pre-run stop without affecting
    // a later message in the same conversation.
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-message-run:' || $1::text, 0))`,
      [input.userMessageId],
    );
    const { rows: cancellationRows } = await client.query<{ user_message_id: string }>(
      `delete from agent_run_cancel_intents
       where user_message_id = $1 and conversation_id = $2 and user_id = $3
         and expires_at > now()
       returning user_message_id`,
      [input.userMessageId, input.conversationId, input.userId],
    );
    if (cancellationRows[0]) return null;

    // Serialize the quota check with other runs created for this user. This
    // prevents concurrent requests from bypassing the active-run limit.
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-active-runs:' || $1::text, 0))`,
      [input.userId],
    );
    const { rows: activeRows } = await client.query<{ count: string }>(
      `select count(*)::text as count
       from agent_runs
       where user_id = $1 and ${activeRunStatusPredicate()}
         and parent_run_id is null`,
      [input.userId],
    );
    if (Number(activeRows[0]?.count || 0) >= serverEnv.AGENT_MAX_ACTIVE_RUNS_PER_USER) {
      throw new Error('AGENT_ACTIVE_RUN_LIMIT');
    }
    // root_run_id is self-referential for a root Run, so the id cannot come from
    // the column default -- it has to be known before the insert.
    const rootRunId = randomUUID();
    const { rows } = await client.query<AgentRunRow>(
      `insert into agent_runs (
         id, root_run_id, depth, ancestor_agent_ids,
         user_id, agent_id, agent_version_id, conversation_id, user_message_id,
         status, started_at, agent_version_snapshot
       ) values ($1, $1, 0, '{}'::uuid[], $2, $3, $4, $5, $6, 'running', now(), $7)
       returning ${runColumns}`,
      [
        rootRunId,
        input.userId,
        input.agentId,
        input.agentVersionId,
        input.conversationId,
        input.userMessageId,
        JSON.stringify(input.agentVersionSnapshot),
      ],
    );
    const createdRun = rows[0];
    const recalledMemoryIds = [...new Set(input.recalledMemoryIds || [])];
    const accountedMemoryIds = await recordAgentMemoryRecallsWithClient(client, {
      userId: input.userId,
      memoryIds: recalledMemoryIds,
      sourceRunId: createdRun.id,
    });
    if (accountedMemoryIds.length !== recalledMemoryIds.length) {
      throw new Error('AGENT_MEMORY_RECALL_SNAPSHOT_STALE');
    }
    await client.query(
      `insert into agent_run_budgets (
         root_run_id, user_id, deadline_at, token_total, iteration_total,
         tool_call_total, subagent_dispatch_total, final_answer_reserve_tokens
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        createdRun.id,
        input.userId,
        input.budget.deadlineAt.toISOString(),
        input.budget.tokenTotal,
        input.budget.iterationTotal,
        input.budget.toolCallTotal,
        input.budget.subagentDispatchTotal,
        input.budget.finalAnswerReserveTokens,
      ],
    );
    const { rows: messageRows } = await client.query<{ id: string }>(
      `insert into messages (conversation_id, role, content, sources)
       values ($1, 'assistant', '', '[]'::jsonb)
       returning id`,
      [input.conversationId],
    );
    const assistantMessageId = messageRows[0]?.id;
    if (!assistantMessageId) throw new Error('AGENT_ASSISTANT_PLACEHOLDER_FAILED');
    const { rows: updatedRows } = await client.query<AgentRunRow>(
      `update agent_runs
       set assistant_message_id = $2
       where id = $1
       returning ${runColumns}`,
      [createdRun.id, assistantMessageId],
    );
    const updatedRun = updatedRows[0];
    await insertAgentWorkItem(client, {
      runId: updatedRun.id,
      rootRunId: updatedRun.root_run_id,
      userId: input.userId,
      agentVersionId: input.agentVersionId,
      kind: 'root',
      payload: input.workItemPayload ?? {
        conversation_id: input.conversationId,
        user_message_id: input.userMessageId,
        assistant_message_id: assistantMessageId,
      },
    });
    return updatedRun;
  });
  if (!run) throw new Error('AGENT_RUN_CANCELLED_BEFORE_START');
  return run;
};

export class AgentSubagentDispatchError extends Error {
  readonly code:
    | 'subagent_depth_exceeded'
    | 'subagent_cycle_detected'
    | 'subagent_parent_not_active'
    | 'subagent_budget_exhausted'
    | 'subagent_deadline_exceeded';

  constructor(
    code: AgentSubagentDispatchError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'AgentSubagentDispatchError';
    this.code = code;
  }
}

/**
 * Create a Run that belongs to an existing tree.
 *
 * Unlike a root Run this writes no assistant placeholder into `messages`: a
 * subagent reports back to whoever dispatched it, and its output reaches the user
 * only through the parent's answer. Letting it insert a message would put
 * intermediate work into the conversation, message search and exports.
 *
 * The depth and cycle guards live here rather than only in the caller because a
 * static check at publish time cannot be sufficient -- binding B into A is legal
 * until B is later published with a binding back to A.
 */
export const createSubagentRun = async (input: {
  userId: string;
  agentId: string;
  agentVersionId: string;
  parentRunId: string;
  parentToolCallId: string;
  agentVersionSnapshot: Record<string, unknown>;
  workItem?: {
    taskIndex: number;
    payload: Record<string, unknown>;
  };
  maxDepth: number;
}) => withTransaction(async (client) => {
  const { rows: parentRows } = await client.query<{
    id: string;
    root_run_id: string;
    depth: number;
    ancestor_agent_ids: string[];
    conversation_id: string;
    status: AgentRunStatus;
    agent_id: string | null;
    parent_work_item_id: string | null;
  }>(
    `select parent.id, parent.root_run_id, parent.depth, parent.ancestor_agent_ids,
            parent.conversation_id, parent.status, parent.agent_id,
            parent_work.id as parent_work_item_id
     from agent_runs parent
     join agent_runs root
       on root.id = parent.root_run_id and root.user_id = parent.user_id
     left join agent_work_items parent_work on parent_work.run_id = parent.id
     where parent.id = $1 and parent.user_id = $2
     for update of root, parent`,
    [input.parentRunId, input.userId],
  );
  const parent = parentRows[0];
  if (!parent) return null;
  // Dispatching from a Run that is already finished would create a child nobody
  // is waiting for, and cancellation of the tree has already happened.
  if (!ACTIVE_RUN_STATUSES.includes(parent.status as typeof ACTIVE_RUN_STATUSES[number])) {
    throw new AgentSubagentDispatchError(
      'subagent_parent_not_active',
      'The dispatching run is no longer active',
    );
  }

  const depth = parent.depth + 1;
  if (depth > input.maxDepth) {
    throw new AgentSubagentDispatchError(
      'subagent_depth_exceeded',
      `Subagent nesting is limited to ${input.maxDepth} levels`,
    );
  }

  // The chain from the root down to and including the parent's own Agent.
  const ancestorAgentIds = [...parent.ancestor_agent_ids, ...(parent.agent_id ? [parent.agent_id] : [])];
  if (ancestorAgentIds.includes(input.agentId)) {
    throw new AgentSubagentDispatchError(
      'subagent_cycle_detected',
      'That Agent is already running higher up in this task',
    );
  }

  // Charge the shared tree ledger in the same transaction that creates the
  // child. Parallel fan-out can therefore create at most the configured number
  // of durable children; a failed child insert rolls the debit back with it.
  const { rows: dispatchBudgetRows } = await client.query<{ deadline_at: string }>(
    `update agent_run_budgets
     set subagent_dispatch_consumed = subagent_dispatch_consumed + 1,
         updated_at = now()
     where root_run_id = $1
       and deadline_at > now()
       and subagent_dispatch_consumed + 1 <= subagent_dispatch_total
     returning deadline_at`,
    [parent.root_run_id],
  );
  if (!dispatchBudgetRows[0]) {
    const { rows: budgetRows } = await client.query<{ deadline_at: string }>(
      `select deadline_at from agent_run_budgets where root_run_id = $1`,
      [parent.root_run_id],
    );
    const deadlineExceeded = Boolean(
      budgetRows[0]
      && new Date(budgetRows[0].deadline_at).getTime() <= Date.now(),
    );
    throw new AgentSubagentDispatchError(
      deadlineExceeded ? 'subagent_deadline_exceeded' : 'subagent_budget_exhausted',
      deadlineExceeded
        ? 'The Agent task deadline has already elapsed'
        : 'The Agent task has no remaining subagent dispatch allowance',
    );
  }

  const { rows } = await client.query<AgentRunRow>(
    `insert into agent_runs (
       root_run_id, parent_run_id, parent_tool_call_id, depth, ancestor_agent_ids,
       user_id, agent_id, agent_version_id, conversation_id,
       status, queued_at, agent_version_snapshot
     ) values ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, 'queued', now(), $10)
     returning ${runColumns}`,
    [
      parent.root_run_id,
      parent.id,
      input.parentToolCallId,
      depth,
      ancestorAgentIds,
      input.userId,
      input.agentId,
      input.agentVersionId,
      parent.conversation_id,
      JSON.stringify(input.agentVersionSnapshot),
    ],
  );
  const createdRun = rows[0];
  if (createdRun && parent.parent_work_item_id && input.workItem) {
    await insertAgentWorkItem(client, {
      runId: createdRun.id,
      rootRunId: createdRun.root_run_id,
      userId: input.userId,
      parentWorkItemId: parent.parent_work_item_id,
      agentVersionId: input.agentVersionId,
      kind: 'subagent',
      dispatchKey: input.parentToolCallId,
      taskIndex: input.workItem.taskIndex,
      payload: input.workItem.payload,
    });
  }
  return createdRun;
});

/**
 * Park a parent while its children work. The guard keeps a cancelled parent from
 * being pulled back into a waiting state by a dispatch that was already in
 * flight.
 */
export const markAgentRunWaitingForSubagents = async (runId: string, userId: string) => {
  const { rows } = await query<AgentRunRow>(
    `update agent_runs
     set status = 'waiting_subagent'
     where id = $1 and user_id = $2 and status = 'running'
     returning ${runColumns}`,
    [runId, userId],
  );
  return rows[0] || null;
};

export const resumeAgentRunFromSubagents = async (runId: string, userId: string) => {
  const { rows } = await query<AgentRunRow>(
    `update agent_runs
     set status = 'running'
     where id = $1 and user_id = $2 and status = 'waiting_subagent'
     returning ${runColumns}`,
    [runId, userId],
  );
  return rows[0] || null;
};

export const updateAgentRun = async (
  runId: string,
  updates: Partial<{
    assistant_message_id: string | null;
    status: AgentRunStatus;
    iteration_count: number;
    tool_call_count: number;
    token_usage: Record<string, number>;
    error_code: string | null;
    error_message: string | null;
    completed_at: string | null;
  }>,
) => {
  const entries = Object.entries(updates).filter((entry) => entry[1] !== undefined);
  if (entries.length === 0) return null;
  const values: unknown[] = [];
  const assignments = entries.map(([key, rawValue]) => {
    const value = key === 'token_usage' ? JSON.stringify(rawValue) : rawValue;
    values.push(value);
    return `${key} = $${values.length}`;
  });
  values.push(runId);
  const statusGuard = updates.status
    ? ` and status in (${ACTIVE_RUN_STATUSES.map((_, index) => `'${ACTIVE_RUN_STATUSES[index]}'`).join(', ')})`
    : '';
  const clearsLease = updates.status
    && ['succeeded', 'failed', 'cancelled'].includes(updates.status)
    ? ', lease_token = null, lease_expires_at = null'
    : '';
  const { rows } = await query<AgentRunRow>(
    `update agent_runs
     set ${assignments.join(', ')}${clearsLease}
     where id = $${values.length}${statusGuard}
     returning ${runColumns}`,
    values,
  );
  return rows[0] || null;
};

export const completeAgentRunForUser = async (input: {
  runId: string;
  userId: string;
  content: string;
  sources: unknown[];
  assistantStepSequence: number;
  iterationCount: number;
  toolCallCount: number;
  tokenUsage: Record<string, number>;
  grounding?: Record<string, unknown>;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
}) => withTransaction(async (client) => {
  const { rows: runRows } = await client.query<AgentRunRow>(
    `select run.*
     from agent_runs run
     join agent_work_items work on work.run_id = run.id
     where run.id = $1 and run.user_id = $2
       and ${activeRunStatusPredicate('run.status')}
       and work.status = 'running'
       and work.lease_token = $3
       and work.fencing_generation = $4
       and work.lease_expires_at > now()
     for update of run, work`,
    [
      input.runId,
      input.userId,
      input.workItemLeaseToken,
      input.workItemFencingGeneration,
    ],
  );
  const run = runRows[0];
  if (!run) return null;
  // The root row lock above serializes this terminal edge with
  // `createSubagentRun`, which locks the root before adding any child. A final
  // answer therefore cannot race a new dispatch into existence after this
  // cleanup. Normally every child is already terminal because dispatch waits
  // for durable outcomes; cancelling leftovers here turns that runtime
  // expectation into a repository invariant and fences any stale worker.
  const { rows: endedDescendants } = await client.query<{ id: string }>(
    `with recursive descendants as (
       select child.id
       from agent_runs child
       where child.parent_run_id = $1 and child.user_id = $2
       union all
       select child.id
       from agent_runs child
       join descendants parent on child.parent_run_id = parent.id
       where child.user_id = $2
     )
     update agent_runs child
     set status = 'cancelled', completed_at = now(),
         error_code = 'agent_run_parent_ended',
         error_message = 'Parent Agent run completed',
         lease_token = null, lease_expires_at = null
     where child.id in (select id from descendants)
       and child.user_id = $2
       and ${activeRunStatusPredicate('child.status')}
     returning child.id`,
    [input.runId, input.userId],
  );
  const closedRunIds = [input.runId, ...endedDescendants.map((descendant) => descendant.id)];
  const { rows: expiredApprovals } = await client.query<{ step_id: string | null }>(
    `update agent_approvals
     set status = 'expired', decided_at = now(),
         reason = 'Agent run completed before the approval was used'
     where user_id = $2 and status = 'pending'
       and (run_id = any($1::uuid[]) or requested_by_run_id = any($1::uuid[]))
     returning step_id`,
    [closedRunIds, input.userId],
  );
  const approvalStepIds = expiredApprovals
    .map((approval) => approval.step_id)
    .filter((stepId): stepId is string => Boolean(stepId));
  if (approvalStepIds.length > 0) {
    await client.query(
      `update agent_steps
       set status = 'failed',
           output = coalesce(output, '{}'::jsonb)
             || jsonb_build_object(
               'decision', 'expired',
               'reason', 'Agent run completed before the approval was used'
             )
       where id = any($1::uuid[])
         and run_id = any($2::uuid[])
         and status in ('pending', 'running')`,
      [approvalStepIds, closedRunIds],
    );
  }
  await client.query(
    `update agent_steps
     set status = 'cancelled',
         output = coalesce(output, '{}'::jsonb)
           || jsonb_build_object('reason', 'Agent run completed')
     where run_id = any($1::uuid[]) and status in ('pending', 'running')`,
    [closedRunIds],
  );
  type AssistantMessage = {
    id: string;
    conversation_id: string;
    role: 'assistant';
    content: string;
    sources: unknown[];
    created_at: string;
  };
  // `createAgentRun` always persists a placeholder, so a null id here means
  // the message was deleted (migration 0036 nulls the reference). Inserting a
  // replacement would drop a ghost answer into a conversation the user
  // truncated or cleared, so treat it as a lost terminalization instead.
  if (!run.assistant_message_id) return null;
  const { rows: messageRows } = await client.query<AssistantMessage>(
    `update messages
     set content = $3, sources = $4
     where id = $1 and conversation_id = $2 and role = 'assistant'
     returning id, conversation_id, role, content, sources, created_at`,
    [
      run.assistant_message_id,
      run.conversation_id,
      input.content,
      JSON.stringify(input.sources),
    ],
  );
  const assistantMessage: AssistantMessage | undefined = messageRows[0];
  if (!assistantMessage) return null;
  await client.query(
    `insert into agent_steps (run_id, sequence, kind, status, content)
     values ($1, $2, 'assistant', 'succeeded', $3)`,
    [input.runId, input.assistantStepSequence, input.content],
  );
  const { rows: completedRows } = await client.query<AgentRunRow>(
      `update agent_runs
       set assistant_message_id = $3, status = 'succeeded',
           iteration_count = $4, tool_call_count = $5, token_usage = $6,
          grounding = $7, completed_at = now(),
          lease_token = null, lease_expires_at = null
     where id = $1 and user_id = $2
       and ${activeRunStatusPredicate()}
     returning ${runColumns}`,
    [
      input.runId,
      input.userId,
      assistantMessage.id,
      input.iterationCount,
      input.toolCallCount,
      JSON.stringify(input.tokenUsage),
      input.grounding ? JSON.stringify(input.grounding) : null,
    ],
  );
  if (!completedRows[0]) throw new Error('AGENT_RUN_TERMINALIZED');
  await appendAgentRunEventWithClient(client, {
    runId: input.runId,
    userId: input.userId,
    eventKey: 'run.completed',
    payload: {
      agentRunId: input.runId,
      assistantMessageId: assistantMessage.id,
      sourceCount: input.sources.length,
      agentEvent: {
        type: 'run.completed',
        runId: input.runId,
        iterationCount: input.iterationCount,
        toolCallCount: input.toolCallCount,
        tokenUsage: input.tokenUsage,
        ...(input.grounding ? { grounding: input.grounding } : {}),
      },
    },
  });
  return { run: completedRows[0], assistantMessage };
});

export const insertAgentStep = async (input: {
  runId: string;
  sequence: number;
  kind: AgentStepKind;
  status: AgentStepStatus;
  toolCallId?: string;
  toolKey?: string;
  input?: unknown;
  output?: unknown;
  content?: string;
  durationMs?: number;
  /**
   * The span this step happened under. Left unset for a Run's own top-level
   * steps; set for work caused by an earlier span, which is what lets a
   * subagent's steps be attributed to the tool call that dispatched it.
   */
  parentSpanId?: string | null;
}) => {
  const payloadBytes = [input.input, input.output, input.content]
    .filter((value) => value !== undefined && value !== null)
    .reduce<number>((total, value) => total + Buffer.byteLength(
      typeof value === 'string' ? value : JSON.stringify(value),
      'utf8',
    ), 0);
  if (payloadBytes > serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES) {
    throw new Error('Agent step payload exceeded its size limit');
  }
  const { rows } = await query<AgentStepRow>(
    // trace_id is read from the Run rather than accepted from the caller: the
    // trace of a step is never a free choice, and deriving it here makes it
    // impossible for a call site to attribute a step to the wrong trace.
    `insert into agent_steps (
       run_id, trace_id, parent_span_id, sequence, kind, status, tool_call_id,
       tool_key, input, output, content, duration_ms
     ) values (
       $1,
       (select root_run_id from agent_runs where id = $1),
       $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
     )
     returning ${stepColumns}`,
    [
      input.runId,
      input.parentSpanId || null,
      input.sequence,
      input.kind,
      input.status,
      input.toolCallId || null,
      input.toolKey || null,
      input.input === undefined ? null : JSON.stringify(input.input),
      input.output === undefined ? null : JSON.stringify(input.output),
      input.content || null,
      input.durationMs ?? null,
    ],
  );
  return rows[0];
};

export interface ClaimedAgentStepIdentity {
  workItemId: string;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
}

export interface AgentApprovalInboxRow extends AgentApprovalRow {
  root_run_status: AgentRunStatus;
  conversation_id: string;
  requesting_agent_id?: string | null;
  requesting_agent_name?: string | null;
  requesting_run_status: AgentRunStatus;
  requesting_depth: number;
  requesting_parent_run_id?: string | null;
}

/** Insert a recovery Step only while the execution claim is still current. */
export const insertClaimedAgentStep = async (
  input: Parameters<typeof insertAgentStep>[0] & ClaimedAgentStepIdentity,
) => {
  const payloadBytes = [input.input, input.output, input.content]
    .filter((value) => value !== undefined && value !== null)
    .reduce<number>((total, value) => total + Buffer.byteLength(
      typeof value === 'string' ? value : JSON.stringify(value),
      'utf8',
    ), 0);
  if (payloadBytes > serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES) {
    throw new Error('Agent step payload exceeded its size limit');
  }
  return withTransaction(async (client) => {
    const { rows: ownerRows } = await client.query<{ root_run_id: string }>(
      `select run.root_run_id
       from agent_runs run
       join agent_work_items work on work.run_id = run.id
       where run.id = $1
         and ${activeRunStatusPredicate('run.status')}
         and work.id = $2 and work.status = 'running'
         and work.lease_token = $3 and work.fencing_generation = $4
         and work.lease_expires_at > now()
       for update of work`,
      [
        input.runId,
        input.workItemId,
        input.workItemLeaseToken,
        input.workItemFencingGeneration,
      ],
    );
    const owner = ownerRows[0];
    if (!owner) return null;
    const { rows } = await client.query<AgentStepRow>(
      `insert into agent_steps (
         run_id, trace_id, parent_span_id, sequence, kind, status, tool_call_id,
         tool_key, input, output, content, duration_ms
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning ${stepColumns}`,
      [
        input.runId,
        owner.root_run_id,
        input.parentSpanId || null,
        input.sequence,
        input.kind,
        input.status,
        input.toolCallId || null,
        input.toolKey || null,
        input.input === undefined ? null : JSON.stringify(input.input),
        input.output === undefined ? null : JSON.stringify(input.output),
        input.content || null,
        input.durationMs ?? null,
      ],
    );
    return rows[0] || null;
  });
};

export const updateAgentStep = async (
  stepId: string,
  runId: string,
  updates: Partial<{
    status: AgentStepStatus;
    output: unknown;
    duration_ms: number;
  }>,
) => {
  const entries = Object.entries(updates).filter((entry) => entry[1] !== undefined);
  if (entries.length === 0) return null;
  const values: unknown[] = [];
  const assignments = entries.map(([key, rawValue]) => {
    values.push(key === 'output' ? JSON.stringify(rawValue) : rawValue);
    return `${key} = $${values.length}`;
  });
  values.push(stepId, runId);
  const statusGuard = updates.status
    ? ` and status in (${ACTIVE_STEP_STATUSES.map((_, index) => `'${ACTIVE_STEP_STATUSES[index]}'`).join(', ')})`
    : '';
  const { rows } = await query<AgentStepRow>(
    `update agent_steps
     set ${assignments.join(', ')}
     where id = $${values.length - 1} and run_id = $${values.length}${statusGuard}
     returning ${stepColumns}`,
    values,
  );
  return rows[0] || null;
};

/** Update a recovery Step only while the Work Item claim still owns the Run. */
export const updateClaimedAgentStep = async (input: ClaimedAgentStepIdentity & {
  stepId: string;
  runId: string;
  status: AgentStepStatus;
  durationMs?: number;
}) => withTransaction(async (client) => {
  const { rows: ownerRows } = await client.query<{ id: string }>(
    `select work.id
     from agent_work_items work
     join agent_runs run on run.id = work.run_id
     where work.id = $1 and work.run_id = $2 and work.status = 'running'
       and work.lease_token = $3 and work.fencing_generation = $4
       and work.lease_expires_at > now()
       and ${activeRunStatusPredicate('run.status')}
     for update of work`,
    [
      input.workItemId,
      input.runId,
      input.workItemLeaseToken,
      input.workItemFencingGeneration,
    ],
  );
  if (!ownerRows[0]) return null;
  const { rows } = await client.query<AgentStepRow>(
    `update agent_steps
     set status = $3, duration_ms = coalesce($4, duration_ms)
     where id = $1 and run_id = $2
       and status in ('pending', 'running')
     returning ${stepColumns}`,
    [input.stepId, input.runId, input.status, input.durationMs ?? null],
  );
  return rows[0] || null;
});

export const findAgentToolCallStepForUser = async (input: {
  runId: string;
  userId: string;
  toolCallId: string;
}) => {
  const { rows } = await query<AgentStepRow>(
    `select ${stepColumnsWithAlias}
     from agent_steps step
     join agent_runs run on run.id = step.run_id
     where step.run_id = $1 and run.user_id = $2
       and step.tool_call_id = $3 and step.kind = 'tool_call'
     order by step.sequence desc
     limit 1`,
    [input.runId, input.userId, input.toolCallId],
  );
  return rows[0] || null;
};

export const findAgentToolResultStepForUser = async (input: {
  runId: string;
  userId: string;
  toolCallId: string;
}) => {
  const { rows } = await query<AgentStepRow>(
    `select ${stepColumnsWithAlias}
     from agent_steps step
     join agent_runs run on run.id = step.run_id
     where step.run_id = $1 and run.user_id = $2
       and step.tool_call_id = $3 and step.kind = 'tool_result'
     order by step.sequence desc
     limit 1`,
    [input.runId, input.userId, input.toolCallId],
  );
  return rows[0] || null;
};

/**
 * Initial memory/policy audit Steps are replay-safe metadata, not model or tool
 * side effects. Recovery uses this marker to avoid duplicating them when a
 * worker dies after the Step insert but before the first model checkpoint.
 */
export const findAgentInitialAuditStepForUser = async (input: {
  runId: string;
  userId: string;
  kind: 'memory_read' | 'tool_policy';
}) => {
  const { rows } = await query<AgentStepRow>(
    `select ${stepColumnsWithAlias}
     from agent_steps step
     join agent_runs run on run.id = step.run_id
     where step.run_id = $1 and run.user_id = $2
       and step.kind = $3
       and step.status = 'succeeded'
       and step.output @> '{"initial_execution_audit":true}'::jsonb
     order by step.sequence asc
     limit 1`,
    [input.runId, input.userId, input.kind],
  );
  return rows[0] || null;
};

export const createAgentApproval = async (input: {
  /**
   * Where the decision is surfaced. For a dispatched subagent this is the tree
   * root, because the chat stream, the approval API and the timeline are all
   * anchored there -- moving the decision to the child would leave it somewhere
   * nobody is looking.
   */
  runId: string;
  stepId: string;
  userId: string;
  expiresAt: string;
  /** The run that actually needs the decision, when it is not `runId` itself. */
  requestedByRunId?: string | null;
  intent: AgentApprovalIntent;
  intentHash: string;
}) => withTransaction(async (client) => {
  // Lock both the decision surface and the requesting Run before inserting.
  // Cancellation takes the same Run-row locks through UPDATE, so exactly one
  // ordering wins: either the approval exists in time to be expired by cancel,
  // or creation observes a terminal Run and fails closed.
  const params = [
    input.runId,
    input.stepId,
    input.userId,
    input.expiresAt,
    input.requestedByRunId ?? null,
    JSON.stringify(input.intent),
    input.intentHash,
  ];
  const { rows: scopeRows } = await client.query<{ root_id: string }>(
    `select root.id as root_id
     from agent_runs root
     join agent_runs requester on requester.id = coalesce($4, $1)
     join agent_steps step on step.id = $2 and step.run_id = requester.id
     where root.id = $1
       and root.user_id = $3
       and ${activeRunStatusPredicate('root.status')}
       and requester.user_id = $3
       and requester.root_run_id = root.root_run_id
       and ${activeRunStatusPredicate('requester.status')}
     for update of root, requester`,
    [input.runId, input.stepId, input.userId, input.requestedByRunId ?? null],
  );
  if (!scopeRows[0]) throw new Error('AGENT_APPROVAL_RUN_NOT_ACTIVE');
  const { rows } = await client.query<AgentApprovalRow>(
    `insert into agent_approvals (
       run_id, step_id, user_id, status, expires_at, requested_by_run_id,
       intent, intent_hash
     ) values ($1, $2, $3, 'pending', $4, $5, $6::jsonb, $7)
     returning ${approvalColumns}`,
    params,
  );
  return rows[0];
});

export const findAgentApprovalForUser = async (
  approvalId: string,
  runId: string,
  userId: string,
) => {
  const { rows } = await query<AgentApprovalRow>(
    `select ${approvalColumns}
     from agent_approvals
     where id = $1 and run_id = $2 and user_id = $3`,
    [approvalId, runId, userId],
  );
  return rows[0] || null;
};

export const isAgentRunActiveForUser = async (runId: string, userId: string) => {
  const { rows } = await query<{ active: boolean }>(
    `select exists (
       select 1 from agent_runs
       where id = $1 and user_id = $2
         and ${activeRunStatusPredicate()}
     ) as active`,
    [runId, userId],
  );
  return Boolean(rows[0]?.active);
};

const wakeAgentWorkItemForApproval = async (
  client: PoolClient,
  approval: Pick<AgentApprovalRow, 'id' | 'run_id' | 'requested_by_run_id'>,
) => {
  const requestingRunId = approval.requested_by_run_id || approval.run_id;
  await client.query(
    `update agent_work_items work
     set status = 'queued', available_at = now(), updated_at = now()
     from agent_run_checkpoints checkpoint
     where work.run_id = $1
       and work.status = 'waiting'
       and checkpoint.run_id = work.run_id
       and checkpoint.boundary = 'approval_wait'
       and checkpoint.payload #>> '{pending,approvalId}' = $2`,
    [requestingRunId, approval.id],
  );
};

const expireStaleAgentApprovalsForUser = async (client: PoolClient, userId: string) => {
  await client.query(
    `with expired as (
       update agent_approvals approval
       set status = 'expired', decided_at = now()
       from agent_runs root
       where approval.run_id = root.id
         and approval.user_id = $1
         and root.user_id = $1
         and approval.status = 'pending'
         and approval.expires_at <= now()
       returning approval.*
     ), closed_steps as (
       update agent_steps step
       set status = 'failed',
           output = coalesce(step.output, '{}'::jsonb)
             || jsonb_build_object('decision', 'expired')
       from expired
       where step.id = expired.step_id
         and step.run_id = coalesce(expired.requested_by_run_id, expired.run_id)
         and step.status in ('pending', 'running')
       returning step.id
     ), woke_work as (
       update agent_work_items work
       set status = 'queued', available_at = now(), updated_at = now()
       from agent_run_checkpoints checkpoint, expired
       where work.run_id = coalesce(expired.requested_by_run_id, expired.run_id)
         and work.status = 'waiting'
         and checkpoint.run_id = work.run_id
         and checkpoint.boundary = 'approval_wait'
         and checkpoint.payload #>> '{pending,approvalId}' = expired.id::text
       returning work.id
     )
     select count(*) from expired`,
    [userId],
  );
};

export const listAgentApprovalInboxForUser = async (input: {
  userId: string;
  status?: AgentApprovalRow['status'];
  limit?: number;
  cursor?: AgentApprovalCursor | null;
}) => withTransaction(async (client) => {
  await expireStaleAgentApprovalsForUser(client, input.userId);
  const status = input.status || 'pending';
  const limit = Math.min(Math.max(input.limit || 20, 1), 100);
  const values: unknown[] = [input.userId, status];
  let cursorPredicate = '';
  if (input.cursor) {
    values.push(input.cursor.createdAt, input.cursor.id);
    cursorPredicate = `
      and (approval.created_at, approval.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
  }
  values.push(limit + 1);
  const { rows } = await client.query<AgentApprovalInboxRow>(
    `select
       approval.id,
       approval.run_id,
       approval.step_id,
       approval.user_id,
       approval.status,
       approval.reason,
       approval.expires_at,
       approval.decided_at,
       approval.requested_by_run_id,
       approval.intent,
       approval.intent_hash,
       approval.created_at,
       root.status as root_run_status,
       root.conversation_id,
       requester.agent_id as requesting_agent_id,
       coalesce(requester.agent_version_snapshot->>'name', agent.name) as requesting_agent_name,
       requester.status as requesting_run_status,
       requester.depth as requesting_depth,
       requester.parent_run_id as requesting_parent_run_id,
       step.tool_call_id,
       step.tool_key,
       step.input,
       step.output
     from agent_approvals approval
     join agent_runs root on root.id = approval.run_id
     join agent_runs requester
       on requester.id = coalesce(approval.requested_by_run_id, approval.run_id)
     left join agents agent on agent.id = requester.agent_id
     left join agent_steps step on step.id = approval.step_id
     where approval.user_id = $1
       and root.user_id = $1
       and requester.user_id = $1
       and requester.root_run_id = root.root_run_id
       and approval.status = $2
       ${cursorPredicate}
     order by approval.created_at desc, approval.id desc
     limit $${values.length}`,
    values,
  );
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor: rows.length > limit && last
      ? encodeAgentApprovalCursor({ createdAt: last.created_at, id: last.id })
      : null,
  };
});

export const decideAgentApprovalForUser = async (input: {
  approvalId: string;
  runId: string;
  userId: string;
  decision: 'approved' | 'rejected';
  reason?: string;
}) => withTransaction(async (client) => {
  const { rows: approvalRows } = await client.query<AgentApprovalRow>(
    `select
       approval.id,
       approval.run_id,
       approval.step_id,
       approval.user_id,
       approval.status,
       approval.reason,
       approval.expires_at,
       approval.decided_at,
       approval.requested_by_run_id,
       approval.intent,
       approval.intent_hash,
       approval.created_at
     from agent_approvals approval
     join agent_runs root on root.id = approval.run_id
     join agent_runs requester
       on requester.id = coalesce(approval.requested_by_run_id, approval.run_id)
     where approval.id = $1 and approval.run_id = $2 and approval.user_id = $3
       and approval.status = 'pending' and approval.expires_at > now()
       and root.user_id = $3
       and ${activeRunStatusPredicate('root.status')}
       and requester.user_id = $3
       and requester.root_run_id = root.root_run_id
       and ${activeRunStatusPredicate('requester.status')}
     for update of approval, root, requester`,
    [input.approvalId, input.runId, input.userId],
  );
  const approval = approvalRows[0];
  if (!approval) return null;

  const { rows } = await client.query<AgentApprovalRow>(
    `update agent_approvals
     set status = $4, reason = $5, decided_at = now()
     where id = $1 and run_id = $2 and user_id = $3 and status = 'pending'
     returning ${approvalColumns}`,
    [input.approvalId, input.runId, input.userId, input.decision, input.reason || ''],
  );
  const decided = rows[0];
  if (!decided) return null;
  if (decided.step_id) {
    const stepStatus = input.decision === 'approved' ? 'succeeded' : 'rejected';
    const { rowCount } = await client.query(
      `update agent_steps
       set status = $3,
           output = coalesce(output, '{}'::jsonb)
             || jsonb_build_object('decision', $4::text, 'reason', $5::text)
       where id = $1
         and run_id = coalesce($2, $6)
         and status in ('pending', 'running')`,
      [
        decided.step_id,
        decided.requested_by_run_id ?? null,
        stepStatus,
        input.decision,
        input.reason || '',
        decided.run_id,
      ],
    );
    if ((rowCount ?? 0) !== 1) throw new Error('AGENT_APPROVAL_STEP_NOT_PENDING');
  }
  // A crashed worker parks its Work Item and releases the lease. Wake that row
  // in the same transaction as the durable decision; an in-process waiter keeps
  // its Work Item running and is therefore unaffected by this update.
  await wakeAgentWorkItemForApproval(client, decided);
  return decided;
});

export const expireAgentApproval = async (approvalId: string, runId: string) => {
  return withTransaction(async (client) => {
    const { rows } = await client.query<AgentApprovalRow>(
      `update agent_approvals
       set status = 'expired', decided_at = now()
       where id = $1 and run_id = $2 and status = 'pending'
       returning ${approvalColumns}`,
      [approvalId, runId],
    );
    const expired = rows[0] || null;
    if (!expired) return null;
    if (expired.step_id) {
      const { rowCount } = await client.query(
        `update agent_steps
         set status = 'failed',
             output = coalesce(output, '{}'::jsonb)
               || jsonb_build_object('decision', 'expired')
         where id = $1
           and run_id = coalesce($2, $3)
           and status in ('pending', 'running')`,
        [expired.step_id, expired.requested_by_run_id ?? null, expired.run_id],
      );
      if ((rowCount ?? 0) !== 1) throw new Error('AGENT_APPROVAL_STEP_NOT_PENDING');
    }
    await wakeAgentWorkItemForApproval(client, expired);
    return expired;
  });
};

export const listAgentRunsForUser = async (input: {
  userId: string;
  agentId?: string;
  conversationId?: string;
  limit?: number;
}) => {
  const values: unknown[] = [input.userId];
  const conditions = ['user_id = $1'];
  if (input.agentId) {
    values.push(input.agentId);
    conditions.push(`agent_id = $${values.length}`);
  }
  if (input.conversationId) {
    values.push(input.conversationId);
    conditions.push(`conversation_id = $${values.length}`);
  }
  values.push(Math.min(Math.max(input.limit || 50, 1), 100));
  const { rows } = await query<AgentRunRow>(
    `select ${runColumns}
     from agent_runs
     where ${conditions.join(' and ')}
     order by created_at desc, id desc
     limit $${values.length}`,
    values,
  );
  return rows;
};

export const findAgentRunForUser = async (
  runId: string,
  userId: string,
  options: { stepLimit?: number; approvalLimit?: number } = {},
): Promise<AgentRunDetail | null> => {
  const { rows } = await query<AgentRunRow>(
    `select ${runColumns}
     from agent_runs
     where id = $1 and user_id = $2`,
    [runId, userId],
  );
  const run = rows[0];
  if (!run) return null;
  const stepLimit = Math.min(Math.max(options.stepLimit || 200, 1), 500);
  const approvalLimit = Math.min(Math.max(options.approvalLimit || 100, 1), 200);

  const [stepResult, approvalResult] = await Promise.all([
    query<AgentStepRow>(
      `select ${stepColumns}
       from agent_steps
       where run_id = $1
       order by sequence asc
       limit $2`,
      [runId, stepLimit + 1],
    ),
    query<AgentApprovalRow>(
      `select
         approval.id,
         approval.run_id,
         approval.step_id,
         approval.user_id,
         approval.status,
         approval.reason,
         approval.expires_at,
         approval.decided_at,
          approval.requested_by_run_id,
          approval.intent,
          approval.intent_hash,
          requester.agent_id as requested_by_agent_id,
         coalesce(
           requester.agent_version_snapshot->>'name',
           requesting_agent.name
         ) as requested_by_agent_name,
         requester.depth as requested_by_depth,
         requester.parent_run_id as requested_by_parent_run_id,
         approval_step.tool_call_id,
         approval_step.tool_key,
         approval_step.input,
         approval_step.output,
         approval.created_at
       from agent_approvals approval
       left join agent_steps approval_step on approval_step.id = approval.step_id
       left join agent_runs requester
         on requester.id = coalesce(approval.requested_by_run_id, approval.run_id)
       left join agents requesting_agent on requesting_agent.id = requester.agent_id
       where approval.run_id = $1 and approval.user_id = $2
       order by approval.created_at asc
       limit $3`,
      [runId, userId, approvalLimit + 1],
    ),
  ]);

  return {
    ...run,
    steps: stepResult.rows.slice(0, stepLimit),
    approvals: approvalResult.rows.slice(0, approvalLimit),
    steps_has_more: stepResult.rows.length > stepLimit,
    approvals_has_more: approvalResult.rows.length > approvalLimit,
  };
};

const appendCancelledAgentRunEvent = (
  client: PoolClient,
  input: { runId: string; userId: string; reason: string },
) => appendAgentRunEventWithClient(client, {
  runId: input.runId,
  userId: input.userId,
  eventKey: 'run.cancelled',
  payload: {
    agentRunId: input.runId,
    agentEvent: {
      type: 'run.cancelled',
      runId: input.runId,
      error: input.reason,
    },
  },
});

export const cancelAgentRunForUser = async (runId: string, userId: string) => {
  return withTransaction(async (client) => {
    // Cancelling a Run must cancel everything it spawned. A subagent left
    // running after its parent was cancelled keeps consuming budget and can
    // still report a result into a Run that no longer wants one -- the same
    // class of defect as an Agent answering into a cleared conversation.
    const { rows } = await client.query<AgentRunRow>(
      `with recursive subtree as (
         select id from agent_runs where id = $1 and user_id = $2
         union all
         select child.id
         from agent_runs child
         join subtree on child.parent_run_id = subtree.id
       )
       update agent_runs
       set status = 'cancelled', completed_at = now(), error_code = 'agent_run_cancelled',
           error_message = 'Agent run cancelled', lease_token = null, lease_expires_at = null
       where id in (select id from subtree)
         and user_id = $2
         and ${activeRunStatusPredicate()}
       returning ${runColumns}`,
      [runId, userId],
    );
    // The requested Run leads the result set only if it was itself active; a
    // parent already parked in waiting_subagent is active, so this holds.
    const run = rows.find((candidate) => candidate.id === runId) || null;
    if (!run) return null;
    const runIds = rows.map((candidate) => candidate.id);

    await client.query(
      `update agent_approvals
       set status = 'expired', decided_at = now(), reason = 'Agent run cancelled'
       where user_id = $2 and status = 'pending'
         and (run_id = any($1::uuid[]) or requested_by_run_id = any($1::uuid[]))`,
      [runIds, userId],
    );
    await client.query(
      `update agent_steps
       set status = 'cancelled',
           output = case
             when output is null then jsonb_build_object('reason', 'Agent run cancelled')
             else output || jsonb_build_object('cancel_reason', 'Agent run cancelled')
           end
       where run_id = any($1::uuid[]) and status in ('pending', 'running')`,
      [runIds],
    );
    const terminal = await ensureTerminalAssistantMessage(
      client,
      run,
      'Agent run cancelled before a final answer was produced.',
    );
    await Promise.all(rows.map((cancelledRun) => appendCancelledAgentRunEvent(client, {
      runId: cancelledRun.id,
      userId,
      reason: 'Agent run cancelled',
    })));
    return terminal;
  });
};

export const cancelActiveAgentRunsForConversationForUser = async (
  conversationId: string,
  userId: string,
) => withTransaction(async (client) => {
  const { rows: messageRows } = await client.query<{ id: string }>(
    `select message.id
     from messages message
     join conversations conversation on conversation.id = message.conversation_id
     where message.conversation_id = $1 and conversation.user_id = $2
       and message.role = 'user'
     order by message.created_at desc, message.id desc
     limit 1`,
    [conversationId, userId],
  );
  const latestUserMessageId = messageRows[0]?.id;
  if (latestUserMessageId) {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-message-run:' || $1::text, 0))`,
      [latestUserMessageId],
    );
    await client.query(
      `insert into agent_run_cancel_intents (
         user_message_id, conversation_id, user_id, requested_at, expires_at
       ) values ($1, $2, $3, now(), now() + ($4::double precision * interval '1 millisecond'))
       on conflict (user_message_id) do update
         set requested_at = excluded.requested_at,
             expires_at = excluded.expires_at`,
      [latestUserMessageId, conversationId, userId, PRE_RUN_CANCELLATION_TTL_MS],
    );
  }
  const { rows } = await client.query<AgentRunRow>(
    `update agent_runs
     set status = 'cancelled', completed_at = now(), error_code = 'agent_run_cancelled',
         error_message = 'Agent run cancelled', lease_token = null, lease_expires_at = null
     where conversation_id = $1 and user_id = $2
       and ${activeRunStatusPredicate()}
     returning ${runColumns}`,
    [conversationId, userId],
  );
  if (rows.length === 0) return [];
  const runIds = rows.map((run) => run.id);
  await client.query(
    `update agent_approvals
     set status = 'expired', decided_at = now(), reason = 'Agent run cancelled'
     where user_id = $2 and status = 'pending'
       and (run_id = any($1::uuid[]) or requested_by_run_id = any($1::uuid[]))`,
    [runIds, userId],
  );
  await client.query(
    `update agent_steps
     set status = 'cancelled',
         output = case
           when output is null then jsonb_build_object('reason', 'Agent run cancelled')
           else output || jsonb_build_object('cancel_reason', 'Agent run cancelled')
         end
     where run_id = any($1::uuid[]) and status in ('pending', 'running')`,
    [runIds],
  );
  const terminalRuns = await Promise.all(rows.map((run) => (
    ensureTerminalAssistantMessage(
      client,
      run,
      'Agent run cancelled before a final answer was produced.',
    )
  )));
  await Promise.all(rows.map((run) => appendCancelledAgentRunEvent(client, {
    runId: run.id,
    userId,
    reason: 'Agent run cancelled',
  })));
  return terminalRuns;
});

export interface RemovedMessageRunScope {
  conversationId: string;
  userId: string;
  /** Truncation boundary: cancel runs anchored at or after this timestamp. */
  createdAtFrom?: string | null;
  /** Explicit message ids being removed (single message delete). */
  messageIds?: string[];
  reason?: string;
}

/**
 * Cancel non-terminal runs whose anchoring messages are being removed.
 *
 * This is deliberately *not* `cancelAgentRunForUser`: an explicit user stop
 * writes a terminal assistant message so the chat shows why generation ended,
 * but here the assistant message is being deleted in the same transaction.
 * Writing a replacement would resurrect the run inside a conversation the user
 * just truncated (migration 0036 nulls `assistant_message_id` on delete, so the
 * later completion path would otherwise insert a brand new message).
 *
 * Must be called inside the same transaction as the delete, and *before* it,
 * so the message-id lookups still see the rows.
 */
export const cancelAgentRunsForRemovedMessagesWithClient = async (
  client: PoolClient,
  scope: RemovedMessageRunScope,
) => {
  const conditions: string[] = [];
  const values: unknown[] = [scope.conversationId, scope.userId];
  if (scope.createdAtFrom) {
    values.push(scope.createdAtFrom);
    const boundary = `$${values.length}::timestamptz`;
    conditions.push(`run.created_at >= ${boundary}`);
    conditions.push(`run.user_message_id in (
      select id from messages
      where conversation_id = $1 and created_at >= ${boundary}
    )`);
    conditions.push(`run.assistant_message_id in (
      select id from messages
      where conversation_id = $1 and created_at >= ${boundary}
    )`);
  }
  if (scope.messageIds && scope.messageIds.length > 0) {
    values.push(scope.messageIds);
    const ids = `$${values.length}::uuid[]`;
    conditions.push(`run.user_message_id = any(${ids})`);
    conditions.push(`run.assistant_message_id = any(${ids})`);
  }
  // No boundary and no ids means "every active run in this conversation",
  // which is what deleting the whole conversation needs.
  const anchorFilter = conditions.length > 0
    ? `and (${conditions.join(' or ')})`
    : '';
  const reason = scope.reason || 'Agent run cancelled because its conversation messages were removed';
  values.push(reason);
  const reasonParam = `$${values.length}`;

  const { rows } = await client.query<Pick<AgentRunRow, 'id'>>(
    `with recursive anchors as (
       select run.id
       from agent_runs run
       where run.conversation_id = $1 and run.user_id = $2
         and ${activeRunStatusPredicate('run.status')}
         ${anchorFilter}
     ), subtree as (
       select id from anchors
       union
       select child.id
       from agent_runs child
       join subtree on child.parent_run_id = subtree.id
       where child.user_id = $2
     )
     update agent_runs run
     set status = 'cancelled', completed_at = now(),
         error_code = 'agent_run_cancelled', error_message = ${reasonParam},
         lease_token = null, lease_expires_at = null
     where run.id in (select id from subtree)
       and run.user_id = $2
       and ${activeRunStatusPredicate('run.status')}
     returning run.id`,
    values,
  );
  if (rows.length === 0) return [];
  const runIds = rows.map((run) => run.id);
  await client.query(
    `update agent_approvals
     set status = 'expired', decided_at = now(), reason = $2
     where status = 'pending'
       and (run_id = any($1::uuid[]) or requested_by_run_id = any($1::uuid[]))`,
    [runIds, reason],
  );
  await client.query(
    `update agent_steps
     set status = 'cancelled',
         output = case
           when output is null then jsonb_build_object('reason', $2::text)
           else output || jsonb_build_object('cancel_reason', $2::text)
         end
     where run_id = any($1::uuid[]) and status in ('pending', 'running')`,
    [runIds, reason],
  );
  await Promise.all(runIds.map((cancelledRunId) => appendCancelledAgentRunEvent(client, {
    runId: cancelledRunId,
    userId: scope.userId,
    reason,
  })));
  return runIds;
};

export const deleteExpiredAgentRunCancelIntents = async () => {
  const { rowCount } = await query(
    `delete from agent_run_cancel_intents where expires_at <= now()`,
  );
  return rowCount ?? 0;
};

export const cancelActiveAgentRunsForAgentForUserWithClient = async (
  client: PoolClient,
  agentId: string,
  userId: string,
  reason = 'Agent was disabled or deleted',
) => {
  const { rows } = await client.query<AgentRunRow>(
    `with recursive subtree as (
       select id
       from agent_runs
       where agent_id = $1 and user_id = $2
         and ${activeRunStatusPredicate()}
       union
       select child.id
       from agent_runs child
       join subtree on child.parent_run_id = subtree.id
       where child.user_id = $2
     )
     update agent_runs
     set status = 'cancelled', completed_at = now(),
         error_code = 'agent_run_cancelled', error_message = $3,
         lease_token = null, lease_expires_at = null
     where id in (select id from subtree) and user_id = $2
       and ${activeRunStatusPredicate()}
     returning ${runColumns}`,
    [agentId, userId, reason],
  );
  if (rows.length === 0) return 0;
  const runIds = rows.map((run) => run.id);
  await client.query(
    `update agent_approvals
     set status = 'expired', decided_at = now(), reason = $2
     where status = 'pending'
       and (run_id = any($1::uuid[]) or requested_by_run_id = any($1::uuid[]))`,
    [runIds, reason],
  );
  await client.query(
    `update agent_steps
     set status = 'cancelled',
         output = case when output is null then jsonb_build_object('reason', $2)
                       else output || jsonb_build_object('reason', $2) end
     where run_id = any($1::uuid[]) and status in ('pending', 'running')`,
    [runIds, reason],
  );
  for (const run of rows) {
    await ensureTerminalAssistantMessage(client, run, `${reason}.`);
  }
  await Promise.all(rows.map((run) => appendCancelledAgentRunEvent(client, {
    runId: run.id,
    userId,
    reason,
  })));
  return rows.length;
};

export const cancelActiveAgentRunsForAgentForUser = async (
  agentId: string,
  userId: string,
  reason = 'Agent was disabled or deleted',
) => withTransaction((client) => cancelActiveAgentRunsForAgentForUserWithClient(
  client,
  agentId,
  userId,
  reason,
));

const ensureTerminalAssistantMessage = async (
  client: Parameters<Parameters<typeof withTransaction>[0]>[0],
  run: AgentRunRow,
  content: string,
) => {
  // Historical fixtures may not include conversation_id; production runs
  // always do. Keep the helper a no-op for such legacy rows.
  if (!run.conversation_id) return run;
  // A missing placeholder means the anchoring message was deleted (truncate,
  // single-message delete, or conversation delete). Never insert a replacement:
  // the terminal state lives on the run row and is delivered over the open SSE
  // stream, while a new message row would reappear in a conversation the user
  // deliberately trimmed.
  if (!run.assistant_message_id) return run;
  await client.query(
    `update messages
     set content = $2
     where id = $1 and conversation_id = $3 and role = 'assistant'
       and content = ''`,
    [run.assistant_message_id, content, run.conversation_id],
  );
  return run;
};

export const finalizeAgentRunForUser = async (input: {
  runId: string;
  userId: string;
  status: Extract<AgentRunStatus, 'failed' | 'cancelled'>;
  iterationCount: number;
  toolCallCount: number;
  tokenUsage: Record<string, number>;
  errorCode: string;
  errorMessage: string;
  assistantMessageContent?: string;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
}) => withTransaction(async (client) => {
  // Ending a parent ends every active descendant. This is the failure-path
  // counterpart of explicit tree cancellation: a timeout or crashed root must
  // not leave child workers running after nobody is waiting for their answer.
  const { rows } = await client.query<AgentRunRow>(
    `with recursive subtree as (
       select run.id
       from agent_runs run
       join agent_work_items work on work.run_id = run.id
       where run.id = $1 and run.user_id = $2
         and work.status = 'running'
         and work.lease_token = $9
         and work.fencing_generation = $10
         and work.lease_expires_at > now()
       union all
       select child.id
       from agent_runs child
       join subtree on child.parent_run_id = subtree.id
     )
     update agent_runs run
     set status = case when run.id = $1 then $3 else 'cancelled' end,
         completed_at = now(),
         iteration_count = case when run.id = $1 then $4 else run.iteration_count end,
         tool_call_count = case when run.id = $1 then $5 else run.tool_call_count end,
         token_usage = case when run.id = $1 then $6 else run.token_usage end,
         error_code = case when run.id = $1 then $7 else 'agent_run_parent_ended' end,
         error_message = case when run.id = $1 then $8 else 'Parent Agent run ended' end,
         lease_token = null,
         lease_expires_at = null
     where run.id in (select id from subtree)
       and run.user_id = $2
       and ${activeRunStatusPredicate('run.status')}
     returning ${runColumns}`,
    [
      input.runId,
      input.userId,
      input.status,
      input.iterationCount,
      input.toolCallCount,
      JSON.stringify(input.tokenUsage),
      input.errorCode,
      input.errorMessage,
      input.workItemLeaseToken,
      input.workItemFencingGeneration,
    ],
  );
  const run = rows.find((candidate) => candidate.id === input.runId) || null;
  if (!run) return null;
  const runIds = rows.map((candidate) => candidate.id);

  await client.query(
    `update agent_approvals
     set status = 'expired', decided_at = now(), reason = $3
     where user_id = $2 and status = 'pending'
       and (run_id = any($1::uuid[]) or requested_by_run_id = any($1::uuid[]))`,
    [runIds, input.userId, input.errorMessage],
  );
  await client.query(
    `update agent_steps
     set status = case when run_id = $4 then $2 else 'cancelled' end,
         output = case
           when output is null then jsonb_build_object('reason', $3)
           else output || jsonb_build_object('reason', $3)
         end
     where run_id = any($1::uuid[]) and status in ('pending', 'running')`,
    [
      runIds,
      input.status === 'cancelled' ? 'cancelled' : 'failed',
      input.errorMessage,
      input.runId,
    ],
  );
  const terminalMessage = input.assistantMessageContent || (
    input.status === 'cancelled'
      ? 'Agent run cancelled before a final answer was produced.'
      : 'Agent run failed before a final answer was produced.'
  );
  const finalized = await ensureTerminalAssistantMessage(
    client,
    run,
    terminalMessage,
  );
  await appendAgentRunEventWithClient(client, {
    runId: input.runId,
    userId: input.userId,
    eventKey: input.status === 'cancelled' ? 'run.cancelled' : 'run.failed',
    payload: {
      agentRunId: input.runId,
      content: terminalMessage,
      agentEvent: {
        type: input.status === 'cancelled' ? 'run.cancelled' : 'run.failed',
        runId: input.runId,
        error: input.errorMessage,
      },
    },
  });
  return finalized;
});

export const failStaleAgentRuns = async (staleAfterMs: number) => {
  return withTransaction(async (client) => {
    const { rows } = await client.query<Pick<
      AgentRunRow,
      'id' | 'conversation_id' | 'assistant_message_id' | 'status'
    >>(
      `with recursive stale_anchors as (
         select id
         from agent_runs
         where ${activeRunStatusPredicate()}
           and coalesce(started_at, created_at) < now() - (
             greatest(
               $1::double precision,
               coalesce(
                 case when jsonb_typeof(agent_version_snapshot->'max_duration_ms') = 'number'
                   then (agent_version_snapshot->>'max_duration_ms')::double precision
                 end,
                 0
               ) + $2::double precision
             ) * interval '1 millisecond'
           )
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
         select id from stale_anchors
         union
         select child.id
         from agent_runs child
         join subtree parent on child.parent_run_id = parent.id
       )
       update agent_runs run
       set status = case
             when run.id in (select id from stale_anchors) then 'failed'
             else 'cancelled'
           end,
           completed_at = now(),
           error_code = case
             when run.id in (select id from stale_anchors) then 'agent_run_stale'
             else 'agent_run_parent_ended'
           end,
           error_message = case
             when run.id in (select id from stale_anchors)
               then 'Agent run was recovered after the worker became unavailable'
             else 'Parent Agent run became stale'
           end,
           lease_token = null, lease_expires_at = null
       where run.id in (select id from subtree)
         and ${activeRunStatusPredicate('run.status')}
       returning run.id, run.conversation_id, run.assistant_message_id, run.status`,
      [staleAfterMs, STALE_RECOVERY_GRACE_MS],
    );
    if (rows.length === 0) return 0;
    const runIds = rows.map((row) => row.id);
    await client.query(
      `update agent_approvals
        set status = 'expired', decided_at = now(),
            reason = 'Agent run was recovered after the worker became unavailable'
        where status = 'pending'
          and (run_id = any($1::uuid[]) or requested_by_run_id = any($1::uuid[]))`,
      [runIds],
    );
    await client.query(
      `update agent_steps
       set status = case
             when run_id = any($2::uuid[]) then 'failed'
             else 'cancelled'
           end,
           output = case
             when output is null then jsonb_build_object('reason', 'Agent run was recovered after the worker became unavailable')
             else output || jsonb_build_object('reason', 'Agent run was recovered after the worker became unavailable')
           end
       where run_id = any($1::uuid[]) and status in ('pending', 'running')`,
      [runIds, rows.filter((row) => row.status === 'failed').map((row) => row.id)],
    );
    for (const row of rows) {
      await ensureTerminalAssistantMessage(client, row as AgentRunRow, 'Agent run was recovered after the worker became unavailable.');
    }
    return rows.length;
  });
};

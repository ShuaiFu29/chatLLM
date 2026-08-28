import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';

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

export const createAgentRun = async (input: {
  userId: string;
  agentId: string;
  agentVersionId: string;
  conversationId: string;
  userMessageId: string;
  agentVersionSnapshot: Record<string, unknown>;
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
    return updatedRows[0];
  });
  if (!run) throw new Error('AGENT_RUN_CANCELLED_BEFORE_START');
  return run;
};

export class AgentSubagentDispatchError extends Error {
  readonly code:
    | 'subagent_depth_exceeded'
    | 'subagent_cycle_detected'
    | 'subagent_parent_not_active';

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
  }>(
    `select id, root_run_id, depth, ancestor_agent_ids, conversation_id, status, agent_id
     from agent_runs
     where id = $1 and user_id = $2
     for update`,
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
  return rows[0];
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
  const { rows } = await query<AgentRunRow>(
    `update agent_runs
     set ${assignments.join(', ')}
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
}) => withTransaction(async (client) => {
  const { rows: runRows } = await client.query<AgentRunRow>(
    `select ${runColumns}
     from agent_runs
     where id = $1 and user_id = $2
       and ${activeRunStatusPredicate()}
     for update`,
    [input.runId, input.userId],
  );
  const run = runRows[0];
  if (!run) return null;
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
         grounding = $7, completed_at = now()
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
}) => {
  const { rows } = await query<AgentApprovalRow>(
    `insert into agent_approvals (run_id, step_id, user_id, status, expires_at, requested_by_run_id)
     values ($1, $2, $3, 'pending', $4, $5)
     returning id, run_id, step_id, user_id, status, reason, expires_at, decided_at,
               requested_by_run_id, created_at`,
    [input.runId, input.stepId, input.userId, input.expiresAt, input.requestedByRunId ?? null],
  );
  return rows[0];
};

export const findAgentApprovalForUser = async (
  approvalId: string,
  runId: string,
  userId: string,
) => {
  const { rows } = await query<AgentApprovalRow>(
    `select id, run_id, step_id, user_id, status, reason, expires_at, decided_at,
            requested_by_run_id, created_at
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

export const decideAgentApprovalForUser = async (input: {
  approvalId: string;
  runId: string;
  userId: string;
  decision: 'approved' | 'rejected';
  reason?: string;
}) => {
  const { rows } = await query<AgentApprovalRow>(
    `update agent_approvals
     set status = $4, reason = $5, decided_at = now()
     where id = $1 and run_id = $2 and user_id = $3
       and status = 'pending' and expires_at > now()
     returning id, run_id, step_id, user_id, status, reason, expires_at, decided_at,
               requested_by_run_id, created_at`,
    [input.approvalId, input.runId, input.userId, input.decision, input.reason || ''],
  );
  return rows[0] || null;
};

export const expireAgentApproval = async (approvalId: string, runId: string) => {
  const { rows } = await query<AgentApprovalRow>(
    `update agent_approvals
     set status = 'expired', decided_at = now()
     where id = $1 and run_id = $2 and status = 'pending'
     returning id, run_id, step_id, user_id, status, reason, expires_at, decided_at,
               requested_by_run_id, created_at`,
    [approvalId, runId],
  );
  return rows[0] || null;
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
      `select id, run_id, step_id, user_id, status, reason, expires_at, decided_at,
            requested_by_run_id, created_at
       from agent_approvals
       where run_id = $1 and user_id = $2
       order by created_at asc
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
           error_message = 'Agent run cancelled'
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

    await client.query(
      `update agent_approvals
       set status = 'expired', decided_at = now(), reason = 'Agent run cancelled'
       where run_id = $1 and user_id = $2 and status = 'pending'`,
      [runId, userId],
    );
    await client.query(
      `update agent_steps
       set status = 'cancelled',
           output = case
             when output is null then jsonb_build_object('reason', 'Agent run cancelled')
             else output || jsonb_build_object('cancel_reason', 'Agent run cancelled')
           end
       where run_id = $1 and status in ('pending', 'running')`,
      [runId],
    );
    return ensureTerminalAssistantMessage(client, run, 'Agent run cancelled before a final answer was produced.');
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
         error_message = 'Agent run cancelled'
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
     where run_id = any($1::uuid[]) and user_id = $2 and status = 'pending'`,
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
  return Promise.all(rows.map((run) => (
    ensureTerminalAssistantMessage(
      client,
      run,
      'Agent run cancelled before a final answer was produced.',
    )
  )));
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
    `update agent_runs run
     set status = 'cancelled', completed_at = now(),
         error_code = 'agent_run_cancelled', error_message = ${reasonParam}
     where run.conversation_id = $1 and run.user_id = $2
       and ${activeRunStatusPredicate('run.status')}
       ${anchorFilter}
     returning run.id`,
    values,
  );
  if (rows.length === 0) return [];
  const runIds = rows.map((run) => run.id);
  await client.query(
    `update agent_approvals
     set status = 'expired', decided_at = now(), reason = $2
     where run_id = any($1::uuid[]) and status = 'pending'`,
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
  return runIds;
};

export const deleteExpiredAgentRunCancelIntents = async () => {
  const { rowCount } = await query(
    `delete from agent_run_cancel_intents where expires_at <= now()`,
  );
  return rowCount ?? 0;
};

export const cancelActiveAgentRunsForAgentForUser = async (
  agentId: string,
  userId: string,
  reason = 'Agent was disabled or deleted',
) => withTransaction(async (client) => {
  const { rows } = await client.query<AgentRunRow>(
    `update agent_runs
     set status = 'cancelled', completed_at = now(),
         error_code = 'agent_run_cancelled', error_message = $3
     where agent_id = $1 and user_id = $2
       and ${activeRunStatusPredicate()}
     returning ${runColumns}`,
    [agentId, userId, reason],
  );
  if (rows.length === 0) return 0;
  const runIds = rows.map((run) => run.id);
  await client.query(
    `update agent_approvals
     set status = 'expired', decided_at = now(), reason = $2
     where run_id = any($1::uuid[]) and status = 'pending'`,
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
  return rows.length;
});

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
}) => withTransaction(async (client) => {
  const { rows } = await client.query<AgentRunRow>(
    `update agent_runs
     set status = $3, completed_at = now(), iteration_count = $4,
         tool_call_count = $5, token_usage = $6, error_code = $7,
         error_message = $8
     where id = $1 and user_id = $2
       and ${activeRunStatusPredicate()}
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
    ],
  );
  const run = rows[0] || null;
  if (!run) return null;

  await client.query(
    `update agent_approvals
     set status = 'expired', decided_at = now(), reason = $3
     where run_id = $1 and user_id = $2 and status = 'pending'`,
    [input.runId, input.userId, input.errorMessage],
  );
  await client.query(
    `update agent_steps
     set status = $2,
         output = case
           when output is null then jsonb_build_object('reason', $3)
           else output || jsonb_build_object('reason', $3)
         end
     where run_id = $1 and status in ('pending', 'running')`,
    [input.runId, input.status === 'cancelled' ? 'cancelled' : 'failed', input.errorMessage],
  );
  return ensureTerminalAssistantMessage(
    client,
    run,
    input.assistantMessageContent || (
      input.status === 'cancelled'
        ? 'Agent run cancelled before a final answer was produced.'
        : 'Agent run failed before a final answer was produced.'
    ),
  );
});

export const failStaleAgentRuns = async (staleAfterMs: number) => {
  return withTransaction(async (client) => {
    const { rows } = await client.query<Pick<AgentRunRow, 'id' | 'conversation_id' | 'assistant_message_id'>>(
      `update agent_runs
       set status = 'failed', completed_at = now(),
           error_code = 'agent_run_stale',
           error_message = 'Agent run was recovered after the worker became unavailable'
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
       returning id, conversation_id, assistant_message_id`,
      [staleAfterMs, STALE_RECOVERY_GRACE_MS],
    );
    if (rows.length === 0) return 0;
    const runIds = rows.map((row) => row.id);
    await client.query(
      `update agent_approvals
       set status = 'expired', decided_at = now(),
           reason = 'Agent run was recovered after the worker became unavailable'
       where run_id = any($1::uuid[]) and status = 'pending'`,
      [runIds],
    );
    await client.query(
      `update agent_steps
       set status = 'failed',
           output = case
             when output is null then jsonb_build_object('reason', 'Agent run was recovered after the worker became unavailable')
             else output || jsonb_build_object('reason', 'Agent run was recovered after the worker became unavailable')
           end
       where run_id = any($1::uuid[]) and status in ('pending', 'running')`,
      [runIds],
    );
    for (const row of rows) {
      await ensureTerminalAssistantMessage(client, row as AgentRunRow, 'Agent run was recovered after the worker became unavailable.');
    }
    return rows.length;
  });
};

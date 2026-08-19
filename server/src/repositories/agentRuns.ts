import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';

export type AgentRunStatus = 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled';
export type AgentStepKind = 'model' | 'tool_call' | 'tool_result' | 'approval' | 'assistant';
export type AgentStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'rejected';

const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_approval'] as const;
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
  created_at: string;
}

export interface AgentRunDetail extends AgentRunRow {
  steps: AgentStepRow[];
  approvals: AgentApprovalRow[];
  steps_has_more: boolean;
  approvals_has_more: boolean;
}

const runColumns = `
  id,
  user_id,
  agent_id,
  agent_version_id,
  conversation_id,
  user_message_id,
  assistant_message_id,
  status,
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
       where user_id = $1 and status in ('queued', 'running', 'waiting_approval')`,
      [input.userId],
    );
    if (Number(activeRows[0]?.count || 0) >= serverEnv.AGENT_MAX_ACTIVE_RUNS_PER_USER) {
      throw new Error('AGENT_ACTIVE_RUN_LIMIT');
    }
    const { rows } = await client.query<AgentRunRow>(
      `insert into agent_runs (
         user_id, agent_id, agent_version_id, conversation_id, user_message_id,
         status, started_at, agent_version_snapshot
       ) values ($1, $2, $3, $4, $5, 'running', now(), $6)
       returning ${runColumns}`,
      [
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
       and status in ('queued', 'running', 'waiting_approval')
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
  let assistantMessage: AssistantMessage | undefined;
  if (run.assistant_message_id) {
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
    assistantMessage = messageRows[0];
  } else {
    const { rows: messageRows } = await client.query<AssistantMessage>(
      `insert into messages (conversation_id, role, content, sources)
       values ($1, 'assistant', $2, $3)
       returning id, conversation_id, role, content, sources, created_at`,
      [run.conversation_id, input.content, JSON.stringify(input.sources)],
    );
    assistantMessage = messageRows[0];
  }
  if (!assistantMessage) throw new Error('AGENT_ASSISTANT_MESSAGE_MISSING');
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
       and status in ('queued', 'running', 'waiting_approval')
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
    `insert into agent_steps (
       run_id, sequence, kind, status, tool_call_id, tool_key, input, output,
       content, duration_ms
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning ${stepColumns}`,
    [
      input.runId,
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
  runId: string;
  stepId: string;
  userId: string;
  expiresAt: string;
}) => {
  const { rows } = await query<AgentApprovalRow>(
    `insert into agent_approvals (run_id, step_id, user_id, status, expires_at)
     values ($1, $2, $3, 'pending', $4)
     returning id, run_id, step_id, user_id, status, reason, expires_at, decided_at, created_at`,
    [input.runId, input.stepId, input.userId, input.expiresAt],
  );
  return rows[0];
};

export const findAgentApprovalForUser = async (
  approvalId: string,
  runId: string,
  userId: string,
) => {
  const { rows } = await query<AgentApprovalRow>(
    `select id, run_id, step_id, user_id, status, reason, expires_at, decided_at, created_at
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
         and status in ('queued', 'running', 'waiting_approval')
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
     returning id, run_id, step_id, user_id, status, reason, expires_at, decided_at, created_at`,
    [input.approvalId, input.runId, input.userId, input.decision, input.reason || ''],
  );
  return rows[0] || null;
};

export const expireAgentApproval = async (approvalId: string, runId: string) => {
  const { rows } = await query<AgentApprovalRow>(
    `update agent_approvals
     set status = 'expired', decided_at = now()
     where id = $1 and run_id = $2 and status = 'pending'
     returning id, run_id, step_id, user_id, status, reason, expires_at, decided_at, created_at`,
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
      `select id, run_id, step_id, user_id, status, reason, expires_at, decided_at, created_at
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
    const { rows } = await client.query<AgentRunRow>(
      `update agent_runs
       set status = 'cancelled', completed_at = now(), error_code = 'agent_run_cancelled',
           error_message = 'Agent run cancelled'
       where id = $1 and user_id = $2
         and status in ('queued', 'running', 'waiting_approval')
       returning ${runColumns}`,
      [runId, userId],
    );
    const run = rows[0] || null;
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
       and status in ('queued', 'running', 'waiting_approval')
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
       and status in ('queued', 'running', 'waiting_approval')
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
  if (run.assistant_message_id) {
    await client.query(
      `update messages
       set content = $2
       where id = $1 and conversation_id = $3 and role = 'assistant'
         and content = ''`,
      [run.assistant_message_id, content, run.conversation_id],
    );
    return run;
  }
  const { rows: messageRows } = await client.query<{ id: string }>(
    `insert into messages (conversation_id, role, content, sources)
     values ($1, 'assistant', $2, '[]'::jsonb)
     returning id`,
    [run.conversation_id, content],
  );
  const assistantMessageId = messageRows[0]?.id;
  if (!assistantMessageId) return run;
  const { rows } = await client.query<AgentRunRow>(
    `update agent_runs
     set assistant_message_id = $2
     where id = $1
     returning ${runColumns}`,
    [run.id, assistantMessageId],
  );
  return rows[0] || { ...run, assistant_message_id: assistantMessageId };
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
       and status in ('queued', 'running', 'waiting_approval')
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
       where status in ('queued', 'running', 'waiting_approval')
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

import { createHash, randomUUID } from 'node:crypto';
import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';
import type { AgentToolRetryMode } from '../modules/agents/runtime/agent-tool';

/**
 * Identity for one logical tool execution, stable across retry attempts.
 *
 * Tool calls were never retried, which is the safe default: retrying a write
 * whose response was lost can duplicate the side effect. The cost of that safety
 * was that a single dropped connection ended the whole Run. A stable idempotency
 * key gives the runtime something to hand the tool so a retry is recognisably the
 * same call, which is what makes a bounded retry safe rather than reckless.
 */

export interface AgentToolInvocationRow {
  idempotency_key: string;
  execution_token: string;
  run_id: string;
  tool_call_id: string;
  tool_key: string;
  attempt_count: number;
  retry_mode: AgentToolRetryMode;
  status: 'in_flight' | 'succeeded' | 'failed' | 'indeterminate';
  error_code?: string | null;
  result_format_version: 1 | null;
  result_payload: AgentToolInvocationResultPayload | null;
  result_hash: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentToolInvocationResultPayload extends Record<string, unknown> {
  modelContent: string;
  evidencePayload?: unknown;
}

const invocationColumns = `
  idempotency_key, execution_token, run_id, tool_call_id, tool_key, attempt_count,
  retry_mode, status, error_code, result_format_version, result_payload, result_hash,
  completed_at, created_at, updated_at
`;

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
};

export const prepareAgentToolInvocationResult = (payload: AgentToolInvocationResultPayload) => {
  if (!payload || typeof payload !== 'object' || typeof payload.modelContent !== 'string') {
    throw new Error('Agent tool result must contain modelContent');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new Error('Agent tool result must be JSON serializable');
  }
  if (!serialized || serialized[0] !== '{') {
    throw new Error('Agent tool result must be an object');
  }
  if (Buffer.byteLength(serialized, 'utf8') > Math.min(
    serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES,
    262_144,
  )) {
    throw new Error('Agent tool result exceeds its durable payload limit');
  }
  const normalized = JSON.parse(serialized) as AgentToolInvocationResultPayload;
  return {
    serialized,
    normalized,
    resultHash: createHash('sha256')
      .update(JSON.stringify(sortJsonValue(normalized)))
      .digest('hex'),
  };
};

export const restoreAgentToolInvocationResult = (row: AgentToolInvocationRow) => {
  if (
    row.status !== 'succeeded'
    || row.result_format_version !== 1
    || !row.result_payload
    || !row.result_hash
  ) return null;
  const prepared = prepareAgentToolInvocationResult(row.result_payload);
  if (prepared.resultHash !== row.result_hash) {
    throw new Error('Agent tool result hash does not match its payload');
  }
  return structuredClone(prepared.normalized);
};

/**
 * Derived from the Run and the model's tool call id, never from the arguments.
 * Keying on arguments would mint a new identity for a retry that serialises a
 * float differently, defeating the purpose; keying on the call id means the same
 * decision by the model keeps one identity for its whole lifetime.
 */
export const buildAgentToolIdempotencyKey = (input: {
  runId: string;
  toolCallId: string;
}) => createHash('sha256')
  .update(`${input.runId}\u0000${input.toolCallId}`)
  .digest('hex');

export const beginAgentToolInvocation = async (input: {
  runId: string;
  toolCallId: string;
  toolKey: string;
  retryMode: AgentToolRetryMode;
  executionToken: string;
}) => {
  const idempotencyKey = buildAgentToolIdempotencyKey(input);
  const { rows } = await query<AgentToolInvocationRow>(
    `insert into agent_tool_invocations (
       idempotency_key, execution_token, run_id, tool_call_id, tool_key, retry_mode, status
     ) values ($1, $2, $3, $4, $5, $6, 'in_flight')
     on conflict (idempotency_key) do update
       set attempt_count = agent_tool_invocations.attempt_count + 1,
           status = 'in_flight',
           retry_mode = excluded.retry_mode,
           error_code = null,
           result_format_version = null,
           result_payload = null,
           result_hash = null,
           completed_at = null,
           updated_at = now()
       where agent_tool_invocations.status = 'in_flight'
         and agent_tool_invocations.execution_token = excluded.execution_token
         and agent_tool_invocations.run_id = excluded.run_id
         and agent_tool_invocations.tool_call_id = excluded.tool_call_id
         and agent_tool_invocations.tool_key = excluded.tool_key
         and agent_tool_invocations.retry_mode = excluded.retry_mode
     returning ${invocationColumns}`,
    [
      idempotencyKey,
      input.executionToken,
      input.runId,
      input.toolCallId,
      input.toolKey,
      input.retryMode,
    ],
  );
  return rows[0];
};

export const finishAgentToolInvocation = async (input: {
  runId: string;
  toolCallId: string;
  executionToken: string;
  status: 'succeeded' | 'failed' | 'indeterminate';
  errorCode?: string | null;
  resultPayload?: AgentToolInvocationResultPayload;
}) => {
  if (input.status === 'succeeded' && !input.resultPayload) {
    throw new Error('A succeeded Agent tool invocation requires a durable result');
  }
  if (input.status !== 'succeeded' && input.resultPayload !== undefined) {
    throw new Error('Only a succeeded Agent tool invocation may store a result');
  }
  const result = input.status === 'succeeded'
    ? prepareAgentToolInvocationResult(input.resultPayload!)
    : null;
  const idempotencyKey = buildAgentToolIdempotencyKey(input);
  const { rows } = await query<AgentToolInvocationRow>(
    `update agent_tool_invocations
     set status = $5, error_code = $6,
         result_format_version = $7, result_payload = $8::jsonb, result_hash = $9,
         completed_at = now(), updated_at = now()
     where idempotency_key = $1
       and run_id = $2
       and tool_call_id = $3
       and execution_token = $4
       and status = 'in_flight'
     returning ${invocationColumns}`,
    [
      idempotencyKey,
      input.runId,
      input.toolCallId,
      input.executionToken,
      input.status,
      input.errorCode || null,
      result ? 1 : null,
      result?.serialized ?? null,
      result?.resultHash ?? null,
    ],
  );
  return rows[0] || null;
};

/**
 * Settle a dispatch whose original worker died while durable children were
 * running. The current Work Item claim is the fencing authority: an old worker
 * cannot overwrite this result after a recovery worker has taken ownership.
 */
export const finishAgentToolInvocationForRecovery = async (input: {
  workItemId: string;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
  runId: string;
  toolCallId: string;
  toolKey: string;
  resultPayload: AgentToolInvocationResultPayload;
}) => {
  const result = prepareAgentToolInvocationResult(input.resultPayload);
  return withTransaction(async (client) => {
    const { rows: ownershipRows } = await client.query<{ id: string }>(
      `select work.id
       from agent_work_items work
       join agent_run_checkpoints checkpoint on checkpoint.run_id = work.run_id
       where work.id = $1 and work.run_id = $2
         and work.status = 'running'
         and work.lease_token = $3
         and work.fencing_generation = $4
         and work.lease_expires_at > now()
         and checkpoint.boundary = 'subagents_wait'
         and checkpoint.payload #>> '{pending,toolCallId}' = $5
       for update of work`,
      [
        input.workItemId,
        input.runId,
        input.workItemLeaseToken,
        input.workItemFencingGeneration,
        input.toolCallId,
      ],
    );
    if (!ownershipRows[0]) return null;

    const { rows: invocationRows } = await client.query<AgentToolInvocationRow>(
      `select ${invocationColumns}
       from agent_tool_invocations
       where run_id = $1 and tool_call_id = $2 and tool_key = $3
       for update`,
      [input.runId, input.toolCallId, input.toolKey],
    );
    const invocation = invocationRows[0];
    if (!invocation) throw new Error('Agent subagent dispatch invocation is missing');
    if (invocation.status === 'succeeded') {
      if (invocation.result_hash !== result.resultHash) {
        throw new Error('Agent subagent dispatch result changed during recovery');
      }
      return invocation;
    }
    if (invocation.status !== 'in_flight') {
      throw new Error('Agent subagent dispatch invocation is not recoverable');
    }

    const { rows } = await client.query<AgentToolInvocationRow>(
      `update agent_tool_invocations
       set status = 'succeeded', error_code = null,
           result_format_version = 1, result_payload = $4::jsonb, result_hash = $5,
           completed_at = now(), updated_at = now()
       where run_id = $1 and tool_call_id = $2 and tool_key = $3
         and status = 'in_flight'
       returning ${invocationColumns}`,
      [input.runId, input.toolCallId, input.toolKey, result.serialized, result.resultHash],
    );
    return rows[0] || null;
  });
};

/**
 * A durable subagent dispatch intentionally stays in-flight while its children
 * run. Unlike a normal tool attempt, a replacement worker may adopt this row:
 * the Work Item claim and subagents_wait checkpoint are the replay fence.
 */
export const ensureAgentSubagentDispatchInvocation = async (input: {
  workItemId: string;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
  runId: string;
  toolCallId: string;
  toolKey: string;
}) => withTransaction(async (client) => {
  const { rows: ownerRows } = await client.query<{ id: string }>(
    `select work.id
     from agent_work_items work
     join agent_run_checkpoints checkpoint on checkpoint.run_id = work.run_id
     join agent_runs run on run.id = work.run_id
     where work.id = $1 and work.run_id = $2 and work.status = 'running'
       and work.lease_token = $3 and work.fencing_generation = $4
       and work.lease_expires_at > now()
       and run.status in ('running', 'waiting_subagent')
       and checkpoint.boundary = 'subagents_wait'
       and checkpoint.payload #>> '{pending,toolCallId}' = $5
     for update of work`,
    [
      input.workItemId,
      input.runId,
      input.workItemLeaseToken,
      input.workItemFencingGeneration,
      input.toolCallId,
    ],
  );
  if (!ownerRows[0]) return null;
  const idempotencyKey = buildAgentToolIdempotencyKey(input);
  const { rows: existingRows } = await client.query<AgentToolInvocationRow>(
    `select ${invocationColumns}
     from agent_tool_invocations
     where idempotency_key = $1 and run_id = $2 and tool_call_id = $3
     for update`,
    [idempotencyKey, input.runId, input.toolCallId],
  );
  const existing = existingRows[0];
  if (existing) {
    if (
      existing.tool_key !== input.toolKey
      || existing.retry_mode !== 'never'
      || !['in_flight', 'succeeded'].includes(existing.status)
    ) throw new Error('Agent subagent dispatch invocation is not adoptable');
    return existing;
  }
  const { rows } = await client.query<AgentToolInvocationRow>(
    `insert into agent_tool_invocations (
       idempotency_key, execution_token, run_id, tool_call_id,
       tool_key, retry_mode, status
     ) values ($1, $2, $3, $4, $5, 'never', 'in_flight')
     returning ${invocationColumns}`,
    [idempotencyKey, randomUUID(), input.runId, input.toolCallId, input.toolKey],
  );
  return rows[0] || null;
});

export const findAgentToolInvocationForRun = async (input: {
  runId: string;
  toolCallId: string;
}) => {
  const idempotencyKey = buildAgentToolIdempotencyKey(input);
  const { rows } = await query<AgentToolInvocationRow>(
    `select ${invocationColumns}
     from agent_tool_invocations
     where idempotency_key = $1 and run_id = $2 and tool_call_id = $3`,
    [idempotencyKey, input.runId, input.toolCallId],
  );
  return rows[0] || null;
};

export const countAgentToolInvocationsForRunAndTool = async (input: {
  runId: string;
  toolKey: string;
}) => {
  const { rows } = await query<{ count: string }>(
    `select count(*)::text as count
     from agent_tool_invocations
     where run_id = $1 and tool_key = $2`,
    [input.runId, input.toolKey],
  );
  return Number(rows[0]?.count || 0);
};

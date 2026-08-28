import { createHash } from 'node:crypto';
import { query } from '../lib/db';

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
  run_id: string;
  tool_call_id: string;
  tool_key: string;
  attempt_count: number;
  status: 'in_flight' | 'succeeded' | 'failed';
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

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
}) => {
  const idempotencyKey = buildAgentToolIdempotencyKey(input);
  const { rows } = await query<AgentToolInvocationRow>(
    `insert into agent_tool_invocations (
       idempotency_key, run_id, tool_call_id, tool_key, status
     ) values ($1, $2, $3, $4, 'in_flight')
     on conflict (idempotency_key) do update
       set attempt_count = agent_tool_invocations.attempt_count + 1,
           status = 'in_flight',
           updated_at = now()
     returning idempotency_key, run_id, tool_call_id, tool_key, attempt_count,
               status, completed_at, created_at, updated_at`,
    [idempotencyKey, input.runId, input.toolCallId, input.toolKey],
  );
  return rows[0];
};

export const finishAgentToolInvocation = async (input: {
  runId: string;
  toolCallId: string;
  status: 'succeeded' | 'failed';
}) => {
  const idempotencyKey = buildAgentToolIdempotencyKey(input);
  const { rows } = await query<AgentToolInvocationRow>(
    `update agent_tool_invocations
     set status = $2, completed_at = now(), updated_at = now()
     where idempotency_key = $1
     returning idempotency_key, run_id, tool_call_id, tool_key, attempt_count,
               status, completed_at, created_at, updated_at`,
    [idempotencyKey, input.status],
  );
  return rows[0] || null;
};

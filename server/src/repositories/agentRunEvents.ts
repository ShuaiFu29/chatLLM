import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from '../lib/db';
import { serverEnv } from '../lib/env';

export const AGENT_RUN_EVENT_FORMAT_VERSION = 1 as const;
const MAX_EVENT_BYTES = Math.min(serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES, 262_144);
const EVENT_KEY_LIMIT = 512;

export interface AgentRunEventRow {
  id: string;
  run_id: string;
  root_run_id: string;
  event_key: string;
  format_version: typeof AGENT_RUN_EVENT_FORMAT_VERSION;
  payload: Record<string, unknown>;
  created_at: string;
}

export class AgentRunEventError extends Error {
  constructor(readonly code: 'invalid' | 'too_large', message: string) {
    super(message);
    this.name = 'AgentRunEventError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

export const prepareAgentRunEvent = (payload: Record<string, unknown>) => {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new AgentRunEventError('invalid', 'Agent run event must be JSON serializable');
  }
  if (!serialized || serialized === 'null' || serialized[0] !== '{') {
    throw new AgentRunEventError('invalid', 'Agent run event payload must be an object');
  }
  const payloadBytes = Buffer.byteLength(serialized, 'utf8');
  if (payloadBytes > MAX_EVENT_BYTES) {
    throw new AgentRunEventError('too_large', 'Agent run event exceeds its byte limit');
  }
  return Object.freeze({
    payload: Object.freeze(JSON.parse(serialized) as Record<string, unknown>),
    serialized,
    payloadBytes,
  });
};

/** Stable event identity makes Worker retry/recovery append idempotent. */
export const createAgentRunEventKey = (payload: Record<string, unknown>) => {
  const event = isRecord(payload.agentEvent) ? payload.agentEvent : null;
  const type = typeof event?.type === 'string' && event.type.trim()
    ? event.type.trim()
    : typeof payload.content === 'string'
      ? 'assistant.content'
      : 'agent.event';
  const subject = [
    event?.approvalId,
    event?.toolCallId,
    payload.assistantMessageId,
  ].find((value) => typeof value === 'string' && value) as string | undefined;
  if (type.startsWith('run.')) return type;
  if (subject) return `${type}:${subject}`.slice(0, EVENT_KEY_LIMIT);
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return `${type}:${digest}`.slice(0, EVENT_KEY_LIMIT);
};

const eventColumns = `
  event.id::text as id, event.run_id, event.root_run_id, event.event_key,
  event.format_version, event.payload, event.created_at
`;

export const appendAgentRunEvent = async (input: {
  runId: string;
  userId: string;
  eventKey: string;
  payload: Record<string, unknown>;
}) => {
  return appendAgentRunEventWithClient(null, input);
};

/**
 * Transactional append used by Run terminalization repositories. Passing a
 * PoolClient makes the terminal state and its replayable notification one
 * commit; null retains the ordinary standalone append API.
 */
export const appendAgentRunEventWithClient = async (
  client: PoolClient | null,
  input: {
    runId: string;
    userId: string;
    eventKey: string;
    payload: Record<string, unknown>;
  },
) => {
  const eventKey = input.eventKey.trim();
  if (!eventKey || eventKey.length > EVENT_KEY_LIMIT) {
    throw new AgentRunEventError('invalid', 'Agent run event key is invalid');
  }
  const prepared = prepareAgentRunEvent(input.payload);
  const runQuery = client
    ? client.query.bind(client) as typeof query
    : query;
  const { rows } = await runQuery<AgentRunEventRow>(
    `insert into agent_run_events as event (
       run_id, root_run_id, event_key, format_version, payload
     )
     select run.id, run.root_run_id, $3, 1, $4::jsonb
     from agent_runs run
     where run.id = $1 and run.user_id = $2
     on conflict (run_id, event_key) do update
       set format_version = excluded.format_version,
           payload = excluded.payload
       where event.payload @> '{"terminalFallback":true}'::jsonb
     returning ${eventColumns}`,
    [input.runId, input.userId, eventKey, prepared.serialized],
  );
  return rows[0] || null;
};

export const listAgentRunEventsForUser = async (input: {
  runId: string;
  userId: string;
  afterId?: string;
  limit?: number;
}) => {
  const afterId = input.afterId?.trim() || '0';
  if (
    !/^\d+$/.test(afterId)
    || afterId.length > 19
    || BigInt(afterId) > 9_223_372_036_854_775_807n
  ) {
    throw new AgentRunEventError('invalid', 'Agent run event cursor is invalid');
  }
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit || 100)));
  const { rows } = await query<AgentRunEventRow>(
    `select ${eventColumns}
     from agent_run_events event
     join agent_runs run on run.id = event.run_id
     where event.run_id = $1 and run.user_id = $2 and event.id > $3::bigint
     order by event.id
     limit $4`,
    [input.runId, input.userId, afterId, limit],
  );
  return rows;
};

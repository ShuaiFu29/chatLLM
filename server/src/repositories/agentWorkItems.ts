import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';
import { RECOVERABLE_EXPIRED_AGENT_WORK_ITEM_SQL } from './agentRecoverySql';
import type { AgentRunCheckpointBoundary } from './agentRunCheckpoints';

export type AgentWorkItemStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AgentWorkItemRow {
  id: string;
  run_id: string;
  root_run_id: string;
  user_id: string;
  parent_work_item_id: string | null;
  agent_version_id: string | null;
  kind: 'root' | 'subagent';
  dispatch_key: string | null;
  task_index: number | null;
  payload: Record<string, unknown>;
  /** PostgreSQL jsonb canonical text used by payload_hash. */
  payload_text: string;
  payload_hash: string;
  status: AgentWorkItemStatus;
  attempt_count: number;
  available_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  fencing_generation: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface ClaimedAgentWorkItem extends AgentWorkItemRow {
  status: 'running';
  lease_token: string;
  lease_expires_at: string;
}

export class AgentWorkItemPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentWorkItemPayloadError';
  }
}

const workItemColumns = `
  id, run_id, root_run_id, user_id, parent_work_item_id, agent_version_id,
  kind, dispatch_key, task_index, payload, payload::text as payload_text,
  payload_hash, status, attempt_count,
  available_at, lease_token, lease_expires_at, fencing_generation,
  error_code, error_message, created_at, started_at, completed_at, updated_at
`;

export const prepareAgentWorkItemPayload = (payload: Record<string, unknown>) => {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new AgentWorkItemPayloadError('Agent work item payload must be JSON serializable');
  }
  if (!serialized || serialized === 'null' || serialized[0] !== '{') {
    throw new AgentWorkItemPayloadError('Agent work item payload must be an object');
  }
  const payloadBytes = Buffer.byteLength(serialized, 'utf8');
  if (payloadBytes > Math.min(serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES, 262_144)) {
    throw new AgentWorkItemPayloadError('Agent work item payload exceeds its byte limit');
  }
  return Object.freeze({
    serialized,
    payloadBytes,
    payloadHash: createHash('sha256').update(serialized).digest('hex'),
  });
};

export const restoreAgentWorkItemPayload = (row: Pick<
  AgentWorkItemRow,
  'payload' | 'payload_text' | 'payload_hash'
>) => {
  if (typeof row.payload_text !== 'string' || !row.payload_text.startsWith('{')) {
    throw new AgentWorkItemPayloadError('Agent work item canonical payload is missing');
  }
  const payloadBytes = Buffer.byteLength(row.payload_text, 'utf8');
  if (payloadBytes > Math.min(serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES, 262_144)) {
    throw new AgentWorkItemPayloadError('Agent work item payload exceeds its byte limit');
  }
  const payloadHash = createHash('sha256').update(row.payload_text).digest('hex');
  if (payloadHash !== row.payload_hash) {
    throw new AgentWorkItemPayloadError('Agent work item payload hash does not match');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_text);
  } catch {
    throw new AgentWorkItemPayloadError('Agent work item payload is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AgentWorkItemPayloadError('Agent work item payload must be an object');
  }
  return Object.freeze(structuredClone(payload as Record<string, unknown>));
};

/** Used from Run-creation transactions so work and Run cannot diverge. */
export const insertAgentWorkItem = async (client: PoolClient, input: {
  runId: string;
  rootRunId: string;
  userId: string;
  parentWorkItemId?: string | null;
  agentVersionId?: string | null;
  kind: 'root' | 'subagent';
  dispatchKey?: string | null;
  taskIndex?: number | null;
  payload: Record<string, unknown>;
}) => {
  const prepared = prepareAgentWorkItemPayload(input.payload);
  const { rows } = await client.query<AgentWorkItemRow>(
    `insert into agent_work_items (
       run_id, root_run_id, user_id, parent_work_item_id, agent_version_id,
       kind, dispatch_key, task_index, payload, payload_hash
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
       encode(digest(($9::jsonb)::text, 'sha256'), 'hex')
     )
     returning ${workItemColumns}`,
    [
      input.runId,
      input.rootRunId,
      input.userId,
      input.parentWorkItemId || null,
      input.agentVersionId || null,
      input.kind,
      input.dispatchKey || null,
      input.taskIndex ?? null,
      prepared.serialized,
    ],
  );
  return rows[0];
};

const claimOne = (input: {
  selector: 'id' | 'run' | 'next';
  selectorValue?: string;
  leaseDurationMs: number;
  requirePriorAttempt?: boolean;
}) => withTransaction(async (client) => {
  const selector = input.selector === 'id'
    ? 'work.id = $1'
    : input.selector === 'run'
      ? 'work.run_id = $1'
      : '$1::text is not null';
  const { rows } = await client.query<AgentWorkItemRow & {
    run_status: string;
    run_parent_id: string | null;
  }>(
    `select work.*, run.status as run_status, run.parent_run_id as run_parent_id
     from agent_work_items work
     join agent_runs run on run.id = work.run_id
     where ${selector}
       and work.status = 'queued'
       and work.available_at <= now()
       ${input.requirePriorAttempt ? `and (
         (
           work.attempt_count > 0
           and exists (
             select 1 from agent_run_checkpoints checkpoint where checkpoint.run_id = work.run_id
           )
         )
         or (
           not exists (
             select 1 from agent_run_checkpoints checkpoint where checkpoint.run_id = work.run_id
           )
           and jsonb_typeof(work.payload -> 'initial_execution') = 'object'
           and jsonb_typeof(work.payload #> '{initial_execution,messages}') = 'array'
           and jsonb_typeof(work.payload #> '{initial_execution,deadline_at}') = 'number'
           and jsonb_typeof(work.payload #> '{initial_execution,optional_history_count}') = 'number'
         )
       )` : ''}
       and run.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
     order by work.available_at, work.created_at
     for update of work, run skip locked
     limit 1`,
    [input.selectorValue || 'next'],
  );
  const candidate = rows[0];
  if (!candidate) return null;
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + Math.max(1, input.leaseDurationMs));
  const { rows: claimedRows } = await client.query<ClaimedAgentWorkItem>(
    `update agent_work_items
     set status = 'running', attempt_count = attempt_count + 1,
         lease_token = $2, lease_expires_at = $3,
         fencing_generation = fencing_generation + 1,
         started_at = coalesce(started_at, now()), updated_at = now()
     where id = $1 and status = 'queued'
     returning ${workItemColumns}`,
    [candidate.id, leaseToken, leaseExpiresAt.toISOString()],
  );
  const claimed = claimedRows[0];
  if (!claimed) return null;

  if (candidate.run_parent_id) {
    const runResult = await client.query(
      `update agent_runs
       set status = case when status = 'queued' then 'running' else status end,
           started_at = coalesce(started_at, now()),
           lease_token = $2, lease_expires_at = $3
       where id = $1 and parent_run_id is not null
         and status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')`,
      [candidate.run_id, leaseToken, leaseExpiresAt.toISOString()],
    );
    if (runResult.rowCount !== 1) throw new Error('AGENT_WORK_ITEM_RUN_CLAIM_CONFLICT');
  }
  return claimed;
});

export const claimAgentWorkItem = async (input: {
  workItemId: string;
  leaseDurationMs: number;
}) => claimOne({
  selector: 'id',
  selectorValue: input.workItemId,
  leaseDurationMs: input.leaseDurationMs,
});

export const claimAgentWorkItemForRun = async (input: {
  runId: string;
  leaseDurationMs: number;
}) => claimOne({
  selector: 'run',
  selectorValue: input.runId,
  leaseDurationMs: input.leaseDurationMs,
});

/** Claim a parked continuation or a fresh hashed execution snapshot. */
export const claimQueuedAgentWorkItemForRecovery = async (input: {
  workItemId: string;
  leaseDurationMs: number;
}) => claimOne({
  selector: 'id',
  selectorValue: input.workItemId,
  leaseDurationMs: input.leaseDurationMs,
  requirePriorAttempt: true,
});

/** Oldest queued row is enough to rebuild delivery after Redis loses messages. */
export const claimNextAgentWorkItem = async (input: { leaseDurationMs: number }) => claimOne({
  selector: 'next',
  leaseDurationMs: input.leaseDurationMs,
});

/**
 * Take recovery ownership from an expired worker without reopening the work.
 * The new token/generation fences every checkpoint, Step and terminal write;
 * callers must inspect durable state before deciding whether to continue or fail.
 */
export const claimExpiredAgentWorkItemForRecovery = async (input: {
  workItemId: string;
  leaseDurationMs: number;
  requiredBoundary?: AgentRunCheckpointBoundary;
}) => withTransaction(async (client) => {
  const { rows: candidates } = await client.query<{
    id: string;
    run_id: string;
    kind: AgentWorkItemRow['kind'];
  }>(
    `select work.id, work.run_id, work.kind
     from agent_work_items work
     join agent_runs run on run.id = work.run_id
     left join agent_run_checkpoints checkpoint on checkpoint.run_id = work.run_id
     where work.id = $1
       and work.status = 'running'
       and work.lease_expires_at <= now()
       and run.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
       and ($2::text is null or checkpoint.boundary = $2)
     for update of work, run skip locked`,
    [input.workItemId, input.requiredBoundary || null],
  );
  const candidate = candidates[0];
  if (!candidate) return null;
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + Math.max(1, input.leaseDurationMs));
  const { rows } = await client.query<ClaimedAgentWorkItem>(
    `update agent_work_items
     set attempt_count = attempt_count + 1,
         lease_token = $2, lease_expires_at = $3,
         fencing_generation = fencing_generation + 1,
         updated_at = now()
     where id = $1 and status = 'running' and lease_expires_at <= now()
     returning ${workItemColumns}`,
    [candidate.id, leaseToken, leaseExpiresAt.toISOString()],
  );
  const claimed = rows[0];
  if (!claimed) return null;
  if (candidate.kind === 'subagent') {
    const { rowCount } = await client.query(
      `update agent_runs
       set lease_token = $2, lease_expires_at = $3
       where id = $1 and parent_run_id is not null
         and status in ('running', 'waiting_approval', 'waiting_subagent')`,
      [candidate.run_id, leaseToken, leaseExpiresAt.toISOString()],
    );
    if (rowCount !== 1) throw new Error('AGENT_WORK_ITEM_RECOVERY_RUN_CONFLICT');
  }
  return claimed;
});

export const renewAgentWorkItemClaim = async (input: {
  workItemId: string;
  leaseToken: string;
  fencingGeneration: number;
  leaseDurationMs: number;
}) => withTransaction(async (client) => {
  const leaseExpiresAt = new Date(Date.now() + Math.max(1, input.leaseDurationMs));
  const { rows } = await client.query<ClaimedAgentWorkItem>(
    `update agent_work_items
     set lease_expires_at = $4, updated_at = now()
     where id = $1 and lease_token = $2 and fencing_generation = $3
       and status = 'running' and lease_expires_at > now()
     returning ${workItemColumns}`,
    [
      input.workItemId,
      input.leaseToken,
      input.fencingGeneration,
      leaseExpiresAt.toISOString(),
    ],
  );
  const renewed = rows[0];
  if (!renewed) return null;
  const runResult = await client.query<{ parent_run_id: string | null }>(
    `update agent_runs
     set lease_expires_at = $3
     where id = $1 and parent_run_id is not null
       and lease_token = $2 and status in ('running', 'waiting_subagent')
     returning parent_run_id`,
    [renewed.run_id, input.leaseToken, leaseExpiresAt.toISOString()],
  );
  if (renewed.kind === 'subagent' && runResult.rowCount !== 1) {
    throw new Error('AGENT_WORK_ITEM_RUN_RENEW_CONFLICT');
  }
  return renewed;
});

const transitionClaimedAgentRunSubagentWait = async (input: {
  workItemId: string;
  leaseToken: string;
  fencingGeneration: number;
  runId: string;
  direction: 'wait' | 'resume';
}) => withTransaction(async (client) => {
  const fromStatus = input.direction === 'wait' ? 'running' : 'waiting_subagent';
  const toStatus = input.direction === 'wait' ? 'waiting_subagent' : 'running';
  const { rows } = await client.query<{ id: string }>(
    `update agent_runs run
     set status = $5
     from agent_work_items work
     where run.id = $1 and work.id = $2 and work.run_id = run.id
       and work.status = 'running' and work.lease_token = $3
       and work.fencing_generation = $4 and work.lease_expires_at > now()
       and run.status = $6
     returning run.id`,
    [
      input.runId,
      input.workItemId,
      input.leaseToken,
      input.fencingGeneration,
      toStatus,
      fromStatus,
    ],
  );
  if (rows[0]) return true;
  const { rows: currentRows } = await client.query<{ status: string }>(
    `select run.status
     from agent_runs run
     join agent_work_items work on work.run_id = run.id
     where run.id = $1 and work.id = $2 and work.status = 'running'
       and work.lease_token = $3 and work.fencing_generation = $4
       and work.lease_expires_at > now()
     for update of work`,
    [input.runId, input.workItemId, input.leaseToken, input.fencingGeneration],
  );
  return currentRows[0]?.status === toStatus;
});

export const markClaimedAgentRunWaitingForSubagents = (input: {
  workItemId: string;
  leaseToken: string;
  fencingGeneration: number;
  runId: string;
}) => transitionClaimedAgentRunSubagentWait({ ...input, direction: 'wait' });

export const resumeClaimedAgentRunFromSubagents = (input: {
  workItemId: string;
  leaseToken: string;
  fencingGeneration: number;
  runId: string;
}) => transitionClaimedAgentRunSubagentWait({ ...input, direction: 'resume' });

export const parkAgentWorkItem = async (input: {
  workItemId: string;
  leaseToken: string;
  fencingGeneration: number;
}) => withTransaction(async (client) => {
  const { rows } = await client.query<AgentWorkItemRow>(
    `update agent_work_items
     set status = 'waiting', lease_token = null, lease_expires_at = null, updated_at = now()
     where id = $1 and lease_token = $2 and fencing_generation = $3 and status = 'running'
     returning ${workItemColumns}`,
    [input.workItemId, input.leaseToken, input.fencingGeneration],
  );
  const parked = rows[0] || null;
  if (!parked) return null;
  if (parked.kind === 'subagent') {
    const result = await client.query(
      `update agent_runs
       set lease_token = null, lease_expires_at = null
       where id = $1 and parent_run_id is not null and lease_token = $2
         and status in ('running', 'waiting_approval', 'waiting_subagent')`,
      [parked.run_id, input.leaseToken],
    );
    if (result.rowCount !== 1) throw new Error('AGENT_WORK_ITEM_PARK_RUN_CONFLICT');
  }
  return parked;
});

export const wakeAgentWorkItem = async (input: {
  workItemId: string;
  availableAt?: Date;
}) => {
  const { rows } = await query<AgentWorkItemRow>(
    `update agent_work_items
     set status = 'queued', available_at = $2, updated_at = now()
     where id = $1 and status = 'waiting'
     returning ${workItemColumns}`,
    [input.workItemId, input.availableAt?.toISOString() || new Date().toISOString()],
  );
  return rows[0] || null;
};

export const listQueuedAgentWorkItemIds = async (limit = 100) => {
  const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const { rows } = await query<{ id: string }>(
    `select work.id
     from agent_work_items work
     join agent_runs run on run.id = work.run_id
     where work.status = 'queued' and work.available_at <= now()
       and run.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
     order by work.available_at, work.created_at
     limit $1`,
    [safeLimit],
  );
  return rows.map((row) => row.id);
};

export const listExpiredAgentWorkItemIds = async (limit = 100) => {
  const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const { rows } = await query<{ id: string }>(
    `select work.id
     from agent_work_items work
     join agent_runs run on run.id = work.run_id
     where work.status = 'running' and work.lease_expires_at <= now()
       and run.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
     order by work.lease_expires_at, work.created_at
     limit $1`,
    [safeLimit],
  );
  return rows.map((row) => row.id);
};

/** Boundaries currently safe for the active durable recovery worker. */
export const listRecoverableExpiredAgentWorkItemIds = async (limit = 100) => {
  const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const { rows } = await query<{ id: string }>(
    `select work.id
     from agent_work_items work
     join agent_runs run on run.id = work.run_id
     left join agent_run_checkpoints checkpoint on checkpoint.run_id = work.run_id
     left join agent_model_invocations invocation
       on invocation.run_id = work.run_id
      and invocation.id::text = checkpoint.payload #>> '{modelInvocation,invocationId}'
     where work.status = 'running' and work.lease_expires_at <= now()
       and run.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
       and ${RECOVERABLE_EXPIRED_AGENT_WORK_ITEM_SQL}
     order by work.lease_expires_at, work.created_at
     limit $1`,
    [safeLimit],
  );
  return rows.map((row) => row.id);
};

/**
 * Rebuild delivery for parked work after an approval/child wake or Redis loss.
 * A generation-zero row is eligible only when its hashed initial execution
 * snapshot can create the first checkpoint under the new claim.
 */
export const listRecoverableQueuedAgentWorkItemIds = async (limit = 100) => {
  const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const { rows } = await query<{ id: string }>(
    `select work.id
     from agent_work_items work
     join agent_runs run on run.id = work.run_id
     left join agent_run_checkpoints checkpoint on checkpoint.run_id = work.run_id
     left join agent_model_invocations invocation
       on invocation.run_id = work.run_id
      and invocation.id::text = checkpoint.payload #>> '{modelInvocation,invocationId}'
     where work.status = 'queued' and work.available_at <= now()
       and run.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
       and ${RECOVERABLE_EXPIRED_AGENT_WORK_ITEM_SQL}
     order by work.available_at, work.created_at
     limit $1`,
    [safeLimit],
  );
  return rows.map((row) => row.id);
};

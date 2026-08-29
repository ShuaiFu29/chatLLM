import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../lib/db';
import type { AgentMemoryScope } from './agentMemories';

export type AgentMemoryEmbeddingJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentMemoryEmbeddingJobRow {
  memory_id: string;
  user_id: string;
  status: AgentMemoryEmbeddingJobStatus;
  attempt_count: number;
  next_attempt_at: string;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ClaimedAgentMemoryEmbeddingJob extends AgentMemoryEmbeddingJobRow {
  status: 'running';
  worker_id: string;
  lease_token: string;
  lease_expires_at: string;
  content: string;
  scope: AgentMemoryScope;
}

interface ClaimableAgentMemoryEmbeddingJob extends AgentMemoryEmbeddingJobRow {
  content: string | null;
  scope: AgentMemoryScope | null;
  memory_status: string | null;
  deleted_at: string | null;
  superseded_by: string | null;
  expires_at: string | null;
  embedding: number[] | null;
  embedding_model: string | null;
  scope_enabled: boolean;
}

const embeddingJobColumns = `
  memory_id, user_id, status, attempt_count, next_attempt_at,
  worker_id, lease_token, lease_expires_at, last_error_code,
  created_at, updated_at, completed_at
`;

const isActiveConfirmedMemory = (job: ClaimableAgentMemoryEmbeddingJob) => (
  job.content !== null
  && job.scope !== null
  && job.memory_status === 'confirmed'
  && !job.deleted_at
  && !job.superseded_by
  && (!job.expires_at || new Date(job.expires_at).getTime() > Date.now())
  && job.embedding === null
  && job.embedding_model === null
  && job.scope_enabled
);

/**
 * Triggers fence explicit lifecycle changes. This periodic reconciliation also
 * handles time-based expiry, which does not itself fire an UPDATE trigger, and
 * therefore remains correct after Redis loses the original wake-up job.
 */
export const reconcileInactiveAgentMemoryEmbeddingJobs = async () => {
  const result = await query(
    `update agent_memory_embedding_jobs job
     set status = 'cancelled',
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         last_error_code = null,
         completed_at = coalesce(job.completed_at, now()),
         updated_at = now()
     from agent_memories memory
     where memory.id = job.memory_id
       and memory.user_id = job.user_id
       and job.status <> 'cancelled'
       and (
         memory.status <> 'confirmed'
         or memory.deleted_at is not null
         or memory.superseded_by is not null
         or (memory.expires_at is not null and memory.expires_at <= now())
         or exists (
           select 1
           from agent_memory_scope_settings setting
           where setting.user_id = memory.user_id
             and setting.scope = memory.scope
             and not setting.enabled
         )
       )`,
  );
  return result.rowCount ?? 0;
};

export const listDispatchableAgentMemoryEmbeddingIds = async (limit = 100) => {
  const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const { rows } = await query<{ memory_id: string }>(
    `select job.memory_id
     from agent_memory_embedding_jobs job
     join agent_memories memory
       on memory.id = job.memory_id and memory.user_id = job.user_id
     left join agent_memory_scope_settings setting
       on setting.user_id = memory.user_id and setting.scope = memory.scope
     where memory.status = 'confirmed'
       and memory.deleted_at is null
       and memory.superseded_by is null
       and (memory.expires_at is null or memory.expires_at > now())
       and memory.embedding is null
       and memory.embedding_model is null
       and coalesce(setting.enabled, true)
       and (
         (job.status = 'queued' and job.next_attempt_at <= now())
         or (
           job.status = 'running'
           and job.lease_expires_at is not null
           and job.lease_expires_at <= now()
         )
       )
     order by
       case job.status when 'queued' then 0 else 1 end,
       job.next_attempt_at,
       job.created_at,
       job.memory_id
     limit $1`,
    [safeLimit],
  );
  return rows.map((row) => row.memory_id);
};

export const claimAgentMemoryEmbeddingJobById = async (input: {
  memoryId: string;
  workerId: string;
  leaseDurationMs: number;
  maxAttempts: number;
}): Promise<ClaimedAgentMemoryEmbeddingJob | null> => withTransaction(async (client) => {
  const { rows } = await client.query<ClaimableAgentMemoryEmbeddingJob>(
    `select
       ${embeddingJobColumns.split(',').map((column) => `job.${column.trim()}`).join(', ')},
       memory.content,
       memory.scope,
       memory.status as memory_status,
       memory.deleted_at,
       memory.superseded_by,
       memory.expires_at,
       memory.embedding,
       memory.embedding_model,
       coalesce(setting.enabled, true) as scope_enabled
     from agent_memory_embedding_jobs job
     left join agent_memories memory
       on memory.id = job.memory_id and memory.user_id = job.user_id
     left join agent_memory_scope_settings setting
       on setting.user_id = memory.user_id and setting.scope = memory.scope
     where job.memory_id = $1
     for update of job`,
    [input.memoryId],
  );
  const current = rows[0];
  if (!current) return null;

  if (!isActiveConfirmedMemory(current)) {
    if (!['completed', 'cancelled', 'failed'].includes(current.status)) {
      await client.query(
        `update agent_memory_embedding_jobs
         set status = 'cancelled', worker_id = null, lease_token = null,
             lease_expires_at = null, last_error_code = null,
             completed_at = now(), updated_at = now()
         where memory_id = $1`,
        [input.memoryId],
      );
    }
    return null;
  }

  const leaseExpired = current.status === 'running'
    && current.lease_expires_at
    && new Date(current.lease_expires_at).getTime() <= Date.now();
  const ready = current.status === 'queued'
    && new Date(current.next_attempt_at).getTime() <= Date.now();
  if (!ready && !leaseExpired) return null;

  if (current.attempt_count >= input.maxAttempts) {
    await client.query(
      `update agent_memory_embedding_jobs
       set status = 'failed', worker_id = null, lease_token = null,
           lease_expires_at = null,
           last_error_code = coalesce(last_error_code, 'attempts_exhausted'),
           completed_at = now(), updated_at = now()
       where memory_id = $1`,
      [input.memoryId],
    );
    return null;
  }

  const leaseToken = randomUUID();
  const { rows: claimedRows } = await client.query<AgentMemoryEmbeddingJobRow>(
    `update agent_memory_embedding_jobs
     set status = 'running',
         attempt_count = attempt_count + 1,
         worker_id = $2,
         lease_token = $3,
         lease_expires_at = now() + ($4::double precision * interval '1 millisecond'),
         last_error_code = null,
         completed_at = null,
         updated_at = now()
     where memory_id = $1
     returning ${embeddingJobColumns}`,
    [
      input.memoryId,
      input.workerId,
      leaseToken,
      Math.max(1, Math.floor(input.leaseDurationMs)),
    ],
  );
  const claimed = claimedRows[0];
  if (!claimed?.worker_id || !claimed.lease_token || !claimed.lease_expires_at) return null;
  return {
    ...claimed,
    status: 'running',
    worker_id: claimed.worker_id,
    lease_token: claimed.lease_token,
    lease_expires_at: claimed.lease_expires_at,
    content: current.content!,
    scope: current.scope!,
  };
});

export const renewAgentMemoryEmbeddingLease = async (input: {
  memoryId: string;
  workerId: string;
  leaseToken: string;
  leaseDurationMs: number;
}) => {
  const { rows } = await query<{ lease_expires_at: string }>(
    `update agent_memory_embedding_jobs
     set lease_expires_at = now() + ($4::double precision * interval '1 millisecond'),
         updated_at = now()
     where memory_id = $1
       and status = 'running'
       and worker_id = $2
       and lease_token = $3
       and lease_expires_at > now()
     returning lease_expires_at`,
    [input.memoryId, input.workerId, input.leaseToken, input.leaseDurationMs],
  );
  return rows[0]?.lease_expires_at ?? null;
};

const assertEmbedding = (embedding: { vector: number[]; model: string }) => {
  if (!Array.isArray(embedding.vector)
    || embedding.vector.length < 1
    || embedding.vector.length > 4_096
    || embedding.vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Agent Memory embedding vector is invalid');
  }
  const model = embedding.model.trim();
  if (!model || model.length > 200) throw new Error('Agent Memory embedding model is invalid');
  return { vector: embedding.vector, model };
};

export const completeAgentMemoryEmbeddingJob = async (input: {
  memoryId: string;
  userId: string;
  workerId: string;
  leaseToken: string;
  embedding: { vector: number[]; model: string };
}) => {
  const embedding = assertEmbedding(input.embedding);
  return withTransaction(async (client) => {
    // Scope opt-out takes this advisory lock before its trigger touches jobs.
    // Follow the same order here (scope lock -> job row) to avoid a deadlock
    // between a completing worker and a concurrent user privacy change.
    const { rows: scopeRows } = await client.query<{ scope: AgentMemoryScope }>(
      `select scope from agent_memories where id = $1 and user_id = $2`,
      [input.memoryId, input.userId],
    );
    const scope = scopeRows[0]?.scope;
    if (!scope) return false;
    await client.query(
      `select pg_advisory_xact_lock(
         hashtextextended('agent-memory-scope:' || $1::text || ':' || $2::text, 0)
       )`,
      [input.userId, scope],
    );
    const { rows: leaseRows } = await client.query<{ memory_id: string }>(
      `select memory_id
       from agent_memory_embedding_jobs
       where memory_id = $1
         and user_id = $2
         and status = 'running'
         and worker_id = $3
         and lease_token = $4
         and lease_expires_at > now()
       for update`,
      [input.memoryId, input.userId, input.workerId, input.leaseToken],
    );
    if (!leaseRows[0]) return false;
    const { rows } = await client.query<{ id: string }>(
      `update agent_memories memory
       set embedding = $5::real[], embedding_model = $6, updated_at = now()
       from agent_memory_embedding_jobs job
       where memory.id = $1
         and memory.user_id = $2
         and job.memory_id = memory.id
         and job.user_id = memory.user_id
         and job.status = 'running'
         and job.worker_id = $3
         and job.lease_token = $4
         and job.lease_expires_at > now()
         and memory.status = 'confirmed'
         and memory.deleted_at is null
         and memory.superseded_by is null
         and (memory.expires_at is null or memory.expires_at > now())
         and memory.embedding is null
         and memory.embedding_model is null
         and not exists (
           select 1
           from agent_memory_scope_settings setting
           where setting.user_id = memory.user_id
             and setting.scope = memory.scope
             and not setting.enabled
         )
       returning memory.id`,
      [
        input.memoryId,
        input.userId,
        input.workerId,
        input.leaseToken,
        embedding.vector,
        embedding.model,
      ],
    );
    return Boolean(rows[0]);
  });
};

export const failAgentMemoryEmbeddingAttempt = async (input: {
  memoryId: string;
  userId: string;
  workerId: string;
  leaseToken: string;
  maxAttempts: number;
  retryBaseDelayMs: number;
  errorCode: string;
}) => {
  const errorCode = /^[a-z][a-z0-9_]{0,63}$/.test(input.errorCode)
    ? input.errorCode
    : 'embedding_failed';
  const { rows } = await query<AgentMemoryEmbeddingJobRow>(
    `update agent_memory_embedding_jobs
     set status = case when attempt_count >= $5 then 'failed' else 'queued' end,
         next_attempt_at = case
           when attempt_count >= $5 then next_attempt_at
           else now() + (
             least($6::double precision * power(2, greatest(attempt_count - 1, 0)), 86400000)
             * interval '1 millisecond'
           )
         end,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         last_error_code = $7,
         completed_at = case when attempt_count >= $5 then now() else null end,
         updated_at = now()
     where memory_id = $1
       and user_id = $2
       and status = 'running'
       and worker_id = $3
       and lease_token = $4
       and lease_expires_at > now()
     returning ${embeddingJobColumns}`,
    [
      input.memoryId,
      input.userId,
      input.workerId,
      input.leaseToken,
      Math.max(1, Math.floor(input.maxAttempts)),
      Math.max(1, Math.floor(input.retryBaseDelayMs)),
      errorCode,
    ],
  );
  return rows[0] ?? null;
};

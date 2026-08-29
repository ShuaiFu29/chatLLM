import type { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';
import { assertAgentMemoryContentSafe } from '../lib/agentMemorySafety';

export type AgentMemoryScope = 'user' | 'project' | 'agent';
export type AgentMemoryKind = 'fact' | 'preference' | 'decision' | 'summary';
export type AgentMemorySourceTrust = 'user_stated' | 'agent_inferred' | 'tool_derived';
export type AgentMemoryStatus = 'candidate' | 'confirmed' | 'rejected';
export type AgentMemoryVerificationStatus =
  | 'unverified'
  | 'legacy_confirmed'
  | 'policy_confirmed'
  | 'user_confirmed'
  | 'user_rejected';
export type AgentMemorySensitivity = 'normal' | 'personal' | 'sensitive' | 'restricted';

export class AgentMemoryWriteError extends Error {
  constructor(
    readonly code: 'scope_disabled' | 'quota_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'AgentMemoryWriteError';
  }
}

export interface AgentMemoryRow {
  id: string;
  user_id: string;
  scope: AgentMemoryScope;
  scope_ref_id?: string | null;
  kind: AgentMemoryKind;
  content: string;
  provenance_run_id?: string | null;
  provenance_step_id?: string | null;
  source_trust: AgentMemorySourceTrust;
  status: AgentMemoryStatus;
  verification_status: AgentMemoryVerificationStatus;
  verified_at?: string | null;
  confidence: number;
  sensitivity: AgentMemorySensitivity;
  last_recalled_at?: string | null;
  recall_count: number | string;
  superseded_by?: string | null;
  deleted_at?: string | null;
  expires_at?: string | null;
  embedding?: number[] | null;
  embedding_model?: string | null;
  created_at: string;
  updated_at: string;
  /** Present on management reads; omitted on internal write/recall rows. */
  scope_enabled?: boolean;
}

export interface AgentMemoryListRow extends AgentMemoryRow {
  scope_ref_name: string | null;
  provenance_agent_id: string | null;
}

const memoryColumns = `
  id,
  user_id,
  scope,
  scope_ref_id,
  kind,
  content,
  provenance_run_id,
  provenance_step_id,
  source_trust,
  status,
  verification_status,
  verified_at,
  confidence,
  sensitivity,
  last_recalled_at,
  recall_count,
  superseded_by,
  deleted_at,
  expires_at,
  embedding,
  embedding_model,
  created_at,
  updated_at
`;

export const MAX_MEMORY_CONTENT_CHARS = 2_000;
export const DELETED_MEMORY_CONTENT = '[deleted]';

const defaultConfidence = (trust: AgentMemorySourceTrust) => {
  if (trust === 'user_stated') return 1;
  if (trust === 'agent_inferred') return 0.6;
  return 0.3;
};

const sensitivityRank: Record<AgentMemorySensitivity, number> = {
  normal: 0,
  personal: 1,
  sensitive: 2,
  restricted: 3,
};

const stricterSensitivity = (
  left: AgentMemorySensitivity,
  right: AgentMemorySensitivity,
) => sensitivityRank[left] >= sensitivityRank[right] ? left : right;

const insertAgentMemoryEvent = async (
  client: PoolClient,
  input: {
    memoryId: string;
    userId: string;
    eventType: 'proposed' | 'confirmed' | 'rejected' | 'recalled' | 'superseded' | 'deleted' | 'expired';
    actorType: 'user' | 'agent' | 'system';
    sourceRunId?: string | null;
    details?: Record<string, unknown>;
  },
) => {
  await client.query(
    `insert into agent_memory_events (
       memory_id, user_id, event_type, actor_type, source_run_id, details
     ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.memoryId,
      input.userId,
      input.eventType,
      input.actorType,
      input.sourceRunId ?? null,
      JSON.stringify(input.details || {}),
    ],
  );
};

/**
 * Store one memory.
 *
 * Re-stating the same fact updates the existing row instead of appending a
 * duplicate: an Agent that remembers on every Run would otherwise grow the store
 * without bound and crowd out everything else at recall time.
 */
export const upsertAgentMemory = async (input: {
  userId: string;
  scope: AgentMemoryScope;
  scopeRefId?: string | null;
  kind: AgentMemoryKind;
  content: string;
  sourceTrust: AgentMemorySourceTrust;
  provenanceRunId?: string | null;
  provenanceStepId?: string | null;
  expiresAt?: Date | null;
  requireConfirmation?: boolean;
  confidence?: number;
  sensitivity?: AgentMemorySensitivity;
  /**
   * Optional relevance vector. Absent when embedding was unavailable, in which
   * case recall falls back to deterministic ordering rather than failing: losing
   * ranking quality must never cost the user a stored memory.
   */
  embedding?: { vector: number[]; model: string } | null;
}) => {
  const content = input.content.trim();
  if (!content || content.length > MAX_MEMORY_CONTENT_CHARS) {
    throw new Error(`Memory content must be 1-${MAX_MEMORY_CONTENT_CHARS} characters`);
  }
  const safety = assertAgentMemoryContentSafe(content);
  // The scope invariant is enforced by the schema too, but failing here gives the
  // caller a usable message instead of a constraint violation.
  const scopeRefId = input.scope === 'user' ? null : input.scopeRefId ?? null;
  if (input.scope !== 'user' && !scopeRefId) {
    throw new Error(`A ${input.scope} memory requires a scope reference`);
  }
  const requiresConfirmation = input.requireConfirmation === true
    || input.sourceTrust === 'tool_derived';
  const status: AgentMemoryStatus = requiresConfirmation ? 'candidate' : 'confirmed';
  const verificationStatus: AgentMemoryVerificationStatus = requiresConfirmation
    ? 'unverified'
    : input.sourceTrust === 'user_stated'
      ? 'user_confirmed'
      : 'policy_confirmed';
  const confidence = input.confidence ?? defaultConfidence(input.sourceTrust);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Memory confidence must be between 0 and 1');
  }
  const sensitivity = input.sensitivity
    ? stricterSensitivity(input.sensitivity, safety.sensitivity)
    : safety.sensitivity;

  try {
    return await withTransaction(async (client) => {
    const { rows } = await client.query<AgentMemoryRow>(
      `insert into agent_memories (
       user_id, scope, scope_ref_id, kind, content, source_trust,
       provenance_run_id, provenance_step_id, expires_at, embedding, embedding_model,
       status, verification_status, verified_at, confidence, sensitivity
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::real[], $11,
       $12, $13, $14, $15, $16
     )
     on conflict (
       user_id, scope,
       coalesce(scope_ref_id, '00000000-0000-0000-0000-000000000000'::uuid),
       kind, md5(content)
     ) where status in ('candidate', 'confirmed')
       and superseded_by is null and deleted_at is null
     do update set
       source_trust = case
         when agent_memories.source_trust = 'user_stated'
           or excluded.source_trust = 'user_stated' then 'user_stated'
         when agent_memories.source_trust = 'agent_inferred'
           or excluded.source_trust = 'agent_inferred' then 'agent_inferred'
         else 'tool_derived'
       end,
       provenance_run_id = excluded.provenance_run_id,
       provenance_step_id = excluded.provenance_step_id,
       expires_at = excluded.expires_at,
       embedding = coalesce(excluded.embedding, agent_memories.embedding),
       embedding_model = coalesce(excluded.embedding_model, agent_memories.embedding_model),
       status = case
         when agent_memories.status = 'confirmed' or excluded.status = 'confirmed'
           then 'confirmed'
         else 'candidate'
       end,
       verification_status = case
         when agent_memories.status = 'confirmed' then agent_memories.verification_status
         when excluded.status = 'confirmed' then excluded.verification_status
         else 'unverified'
       end,
       verified_at = case
         when agent_memories.status = 'confirmed' then agent_memories.verified_at
         when excluded.status = 'confirmed' then excluded.verified_at
         else null
       end,
       confidence = greatest(agent_memories.confidence, excluded.confidence),
       sensitivity = case
         when agent_memories.sensitivity = 'restricted'
           or excluded.sensitivity = 'restricted' then 'restricted'
         when agent_memories.sensitivity = 'sensitive'
           or excluded.sensitivity = 'sensitive' then 'sensitive'
         when agent_memories.sensitivity = 'personal'
           or excluded.sensitivity = 'personal' then 'personal'
         else 'normal'
       end,
       updated_at = now()
     returning ${memoryColumns}`,
      [
        input.userId,
        input.scope,
        scopeRefId,
        input.kind,
        content,
        input.sourceTrust,
        input.provenanceRunId ?? null,
        input.provenanceStepId ?? null,
        input.expiresAt ? input.expiresAt.toISOString() : null,
        input.embedding ? input.embedding.vector : null,
        input.embedding ? input.embedding.model : null,
        status,
        verificationStatus,
        status === 'confirmed' ? new Date().toISOString() : null,
        confidence,
        sensitivity,
      ],
    );
    const memory = rows[0];
    await insertAgentMemoryEvent(client, {
      memoryId: memory.id,
      userId: input.userId,
      eventType: memory.status === 'confirmed' ? 'confirmed' : 'proposed',
      actorType: 'agent',
      sourceRunId: input.provenanceRunId,
      details: { source_trust: input.sourceTrust },
    });
    if (input.provenanceRunId) {
      await client.query(
        `insert into agent_memory_evidence (
           memory_id, user_id, evidence_kind, source_run_id, source_step_id, metadata
         ) values ($1, $2, 'agent_run', $3, $4, $5::jsonb)
         on conflict do nothing`,
        [
          memory.id,
          input.userId,
          input.provenanceRunId,
          input.provenanceStepId ?? null,
          JSON.stringify({ source_trust: input.sourceTrust }),
        ],
      );
    }
      return memory;
    });
  } catch (error) {
    const constraint = error && typeof error === 'object'
      ? (error as { constraint?: unknown }).constraint
      : null;
    if (constraint === 'agent_memories_scope_enabled_check') {
      throw new AgentMemoryWriteError(
        'scope_disabled',
        `The ${input.scope} Memory scope is disabled by the user`,
      );
    }
    if (constraint === 'agent_memories_scope_quota_check') {
      throw new AgentMemoryWriteError(
        'quota_exceeded',
        `The ${input.scope} Memory scope has reached its active-memory quota`,
      );
    }
    throw error;
  }
};

/**
 * Replace an earlier memory with a newer one, so a changed decision does not sit
 * next to the decision it replaced.
 */
export const supersedeAgentMemory = async (input: {
  userId: string;
  memoryId: string;
  supersededById: string;
}) => {
  if (input.memoryId === input.supersededById) return null;

  return withTransaction(async (client) => {
    // Lock both rows in a stable order before checking either one. Without this,
    // concurrent A -> B and B -> A requests can each observe two active rows and
    // commit a cycle. Restricting the lock to this user also avoids letting a
    // guessed UUID hold another user's memory row hostage.
    const { rows: locked } = await client.query<{ id: string }>(
      `select id
       from agent_memories
       where user_id = $1 and id = any($2::uuid[])
       order by id
       for update`,
      [input.userId, [input.memoryId, input.supersededById]],
    );
    if (locked.length !== 2) return null;

    const { rows } = await client.query<AgentMemoryRow>(
      `with updated as (
       update agent_memories memory
       set superseded_by = replacement.id, updated_at = now()
       from agent_memories replacement
       where memory.id = $2
         and memory.user_id = $1
         and memory.deleted_at is null
         and memory.superseded_by is null
         and memory.status = 'confirmed'
         and replacement.id = $3
         and replacement.user_id = memory.user_id
         and replacement.scope = memory.scope
         and replacement.scope_ref_id is not distinct from memory.scope_ref_id
         and replacement.deleted_at is null
         and replacement.superseded_by is null
         and replacement.status = 'confirmed'
         and (replacement.expires_at is null or replacement.expires_at > now())
         and memory.id <> replacement.id
         and not exists (
           with recursive replacement_chain(id, superseded_by, path) as (
             select id, superseded_by, array[id]
             from agent_memories
             where id = replacement.id
             union all
             select next.id, next.superseded_by, chain.path || next.id
             from replacement_chain chain
             join agent_memories next on next.id = chain.superseded_by
             where not next.id = any(chain.path)
           )
           select 1 from replacement_chain where id = memory.id
         )
       returning memory.*
     )
     select ${memoryColumns} from updated`,
      [input.userId, input.memoryId, input.supersededById],
    );
    const memory = rows[0] || null;
    if (memory) {
      await insertAgentMemoryEvent(client, {
        memoryId: memory.id,
        userId: input.userId,
        eventType: 'superseded',
        actorType: 'user',
        details: { replacement_memory_id: input.supersededById },
      });
    }
    return memory;
  });
};

export const forgetAgentMemory = async (userId: string, memoryId: string) => {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `update agent_memories
     set deleted_at = now(),
         content = $3,
         embedding = null,
         embedding_model = null,
         provenance_run_id = null,
         provenance_step_id = null,
         expires_at = null,
         updated_at = now()
     where id = $1 and user_id = $2 and deleted_at is null
     returning id`,
      [memoryId, userId, DELETED_MEMORY_CONTENT],
    );
    const removed = rows[0]?.id || null;
    if (removed) {
      await insertAgentMemoryEvent(client, {
        memoryId: removed,
        userId,
        eventType: 'deleted',
        actorType: 'user',
      });
    }
    return removed;
  });
};

export const decideAgentMemory = async (input: {
  userId: string;
  memoryId: string;
  decision: 'confirmed' | 'rejected';
}) => withTransaction(async (client) => {
  const { rows: locked } = await client.query<AgentMemoryRow>(
    `select ${memoryColumns}
     from agent_memories
     where id = $1 and user_id = $2 and deleted_at is null
     for update`,
    [input.memoryId, input.userId],
  );
  const current = locked[0];
  if (!current || current.superseded_by) return { kind: 'not_found' as const };
  if (current.status === input.decision) {
    return { kind: 'unchanged' as const, memory: current };
  }
  if (current.status !== 'candidate') {
    return { kind: 'conflict' as const, memory: current };
  }
  const verificationStatus = input.decision === 'confirmed'
    ? 'user_confirmed'
    : 'user_rejected';
  const { rows } = await client.query<AgentMemoryRow>(
    `update agent_memories
     set status = $3,
         verification_status = $4,
         verified_at = now(),
         embedding = case when $3 = 'rejected' then null else embedding end,
         embedding_model = case when $3 = 'rejected' then null else embedding_model end,
         updated_at = now()
     where id = $1 and user_id = $2 and status = 'candidate'
     returning ${memoryColumns}`,
    [input.memoryId, input.userId, input.decision, verificationStatus],
  );
  const memory = rows[0];
  if (!memory) return { kind: 'conflict' as const, memory: current };
  await insertAgentMemoryEvent(client, {
    memoryId: memory.id,
    userId: input.userId,
    eventType: input.decision,
    actorType: 'user',
  });
  if (input.decision === 'confirmed') {
    await client.query(
      `insert into agent_memory_evidence (
         memory_id, user_id, evidence_kind, metadata
       ) values ($1, $2, 'user_confirmation', '{}'::jsonb)
       on conflict do nothing`,
      [memory.id, input.userId],
    );
  }
  return { kind: 'updated' as const, memory };
});

/**
 * Read the memories that may be injected into a Run.
 *
 * Superseded and expired rows are excluded in SQL rather than filtered afterwards
 * so an expired memory can never reach a prompt through a code path that forgot to
 * check. Ordering puts what the user said themselves ahead of what the model
 * inferred, and both ahead of anything derived from an untrusted tool response.
 */
export const listRecallableAgentMemories = async (input: {
  userId: string;
  projectSpaceId?: string | null;
  agentId?: string | null;
  /** Omit for the legacy user + project + agent union; an empty set recalls none. */
  scopes?: AgentMemoryScope[];
  /** Lowest accepted trust. `tool_derived` preserves the legacy all-trust union. */
  minimumSourceTrust?: AgentMemorySourceTrust;
  /** Keep one scope from crowding every other allowed scope out of the pool. */
  perScopeLimit?: number;
  limit: number;
}) => {
  const limit = Math.min(Math.max(input.limit, 1), 150);
  const perScopeLimit = Math.min(Math.max(input.perScopeLimit ?? limit, 1), 50);
  const scopes = [...new Set(input.scopes ?? ['user', 'project', 'agent'])];
  if (scopes.length === 0) return [];
  if (scopes.some((scope) => !['user', 'project', 'agent'].includes(scope))) {
    throw new Error('Invalid Agent memory scope');
  }
  const minimumSourceTrust = input.minimumSourceTrust ?? 'tool_derived';
  if (!['user_stated', 'agent_inferred', 'tool_derived'].includes(minimumSourceTrust)) {
    throw new Error('Invalid Agent memory trust threshold');
  }
  const { rows } = await query<AgentMemoryRow>(
    `with eligible_memories as (
       select ${memoryColumns},
         row_number() over (
           partition by scope
           order by
             case source_trust
               when 'user_stated' then 0
               when 'agent_inferred' then 1
               else 2
             end,
             case kind
               when 'preference' then 0
               when 'decision' then 1
               when 'fact' then 2
               else 3
             end,
             created_at desc,
             id desc
         ) as scope_rank
       from agent_memories
       where user_id = $1
         and superseded_by is null
         and deleted_at is null
         and status = 'confirmed'
         and not exists (
           select 1
           from agent_memory_scope_settings setting
           where setting.user_id = agent_memories.user_id
             and setting.scope = agent_memories.scope
             and not setting.enabled
         )
         and (expires_at is null or expires_at > now())
         and scope = any($4::text[])
         and case source_trust
           when 'user_stated' then 0
           when 'agent_inferred' then 1
           else 2
         end <= case $5::text
           when 'user_stated' then 0
           when 'agent_inferred' then 1
           else 2
         end
         and (
           scope = 'user'
           or (scope = 'project' and scope_ref_id = $2::uuid)
           or (scope = 'agent' and scope_ref_id = $3::uuid)
         )
     )
     select ${memoryColumns}
     from eligible_memories
     where scope_rank <= $6
     order by
       scope_rank,
       case source_trust
         when 'user_stated' then 0
         when 'agent_inferred' then 1
         else 2
       end,
       created_at desc,
       id desc
     limit $7`,
    [
      input.userId,
      input.projectSpaceId ?? null,
      input.agentId ?? null,
      scopes,
      minimumSourceTrust,
      perScopeLimit,
      limit,
    ],
  );
  return rows;
};

export const listAgentMemoriesForUser = async (input: {
  userId: string;
  scope?: AgentMemoryScope;
  status?: AgentMemoryStatus;
  search?: string;
  cursor?: { createdAt: string; id: string } | null;
  limit: number;
  offset: number;
}) => {
  const limit = Math.min(Math.max(input.limit, 1), 101);
  const { rows } = await query<AgentMemoryListRow>(
    `with page as (
       select ${memoryColumns}
       from agent_memories
       where user_id = $1
         and deleted_at is null
         and ($2::text is null or scope = $2)
         and ($3::text is null or status = $3)
         and ($4::text is null or strpos(lower(content), lower($4)) > 0)
         and (
           $5::timestamptz is null
           or created_at < $5::timestamptz
           or (created_at = $5::timestamptz and id < $6::uuid)
         )
       order by created_at desc, id desc
       limit $7 offset $8
     )
     select
       page.*,
       case page.scope
         when 'project' then project.name
         when 'agent' then agent.name
         else null
       end as scope_ref_name,
       provenance.agent_id as provenance_agent_id,
       coalesce(setting.enabled, true) as scope_enabled
     from page
     left join project_spaces project
       on page.scope = 'project'
      and project.id = page.scope_ref_id
      and project.user_id = page.user_id
     left join agents agent
       on page.scope = 'agent'
      and agent.id = page.scope_ref_id
      and agent.user_id = page.user_id
     left join agent_runs provenance
       on provenance.id = page.provenance_run_id
      and provenance.user_id = page.user_id
     left join agent_memory_scope_settings setting
       on setting.user_id = page.user_id
      and setting.scope = page.scope
     order by page.created_at desc, page.id desc`,
    [
      input.userId,
      input.scope ?? null,
      input.status ?? null,
      input.search ?? null,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
      limit,
      Math.max(0, input.offset),
    ],
  );
  return rows;
};

/**
 * Erase expired payloads and leave lifecycle tombstones. Recall already ignores
 * them; retaining only the chain metadata prevents superseded facts from being
 * resurrected while removing content nobody should read again.
 */
export const deleteExpiredAgentMemories = async () => {
  const { rows } = await query<{ memory_id: string }>(
    `with expired as (
       update agent_memories
     set deleted_at = now(),
         content = $1,
         embedding = null,
         embedding_model = null,
         provenance_run_id = null,
         provenance_step_id = null,
         expires_at = null,
         updated_at = now()
       where expires_at is not null and expires_at <= now() and deleted_at is null
       returning id, user_id
     )
     insert into agent_memory_events (
       memory_id, user_id, event_type, actor_type, details
     )
     select id, user_id, 'expired', 'system', '{}'::jsonb
     from expired
     returning memory_id`,
    [DELETED_MEMORY_CONTENT],
  );
  return rows.length;
};

export const recordAgentMemoryRecallsWithClient = async (
  client: PoolClient,
  input: {
    userId: string;
    memoryIds: readonly string[];
    sourceRunId?: string | null;
  },
) => {
  const memoryIds = [...new Set(input.memoryIds)];
  if (memoryIds.length === 0) return [];

  // Recall and scope mutation must share one serialization point. Otherwise a
  // Run can resolve a Memory, race with the user disabling that scope, and then
  // commit a stale prompt snapshot after the opt-out was already acknowledged.
  // Sorting prevents two multi-scope recalls from taking the same locks in a
  // different order and deadlocking each other.
  const { rows: scopeRows } = await client.query<{ scope: AgentMemoryScope }>(
    `select distinct scope
     from agent_memories
     where user_id = $1 and id = any($2::uuid[])
     order by scope asc`,
    [input.userId, memoryIds],
  );
  for (const { scope } of scopeRows) {
    await client.query(
      `select pg_advisory_xact_lock(
         hashtextextended('agent-memory-scope:' || $1::text || ':' || $2::text, 0)
       )`,
      [input.userId, scope],
    );
  }

  const { rows } = await client.query<{ id: string }>(
    `update agent_memories memory
       set recall_count = recall_count + 1,
           last_recalled_at = now(),
           updated_at = now()
       where memory.user_id = $1
         and memory.id = any($2::uuid[])
         and memory.status = 'confirmed'
         and memory.superseded_by is null
         and memory.deleted_at is null
         and not exists (
           select 1
           from agent_memory_scope_settings setting
           where setting.user_id = memory.user_id
             and setting.scope = memory.scope
             and not setting.enabled
         )
         and (memory.expires_at is null or memory.expires_at > now())
       returning id`,
      [input.userId, memoryIds],
  );
  for (const memory of rows) {
    await insertAgentMemoryEvent(client, {
      memoryId: memory.id,
      userId: input.userId,
      eventType: 'recalled',
      actorType: 'system',
      sourceRunId: input.sourceRunId,
    });
  }
  return rows.map((memory) => memory.id);
};

export const recordAgentMemoryRecalls = async (input: {
  userId: string;
  memoryIds: readonly string[];
  sourceRunId?: string | null;
}) => withTransaction((client) => recordAgentMemoryRecallsWithClient(client, input));

export const getAgentMemoryGovernanceForUser = async (memoryId: string, userId: string) => {
  const [{ rows: memories }, { rows: evidence }, { rows: events }] = await Promise.all([
    query<AgentMemoryRow>(
      `select ${memoryColumns},
         not exists (
           select 1
           from agent_memory_scope_settings setting
           where setting.user_id = agent_memories.user_id
             and setting.scope = agent_memories.scope
             and not setting.enabled
         ) as scope_enabled
       from agent_memories
       where id = $1 and user_id = $2 and deleted_at is null`,
      [memoryId, userId],
    ),
    query(
      `select id, memory_id, evidence_kind, source_run_id, source_step_id, metadata, created_at
       from agent_memory_evidence
       where memory_id = $1 and user_id = $2
       order by created_at asc, id asc`,
      [memoryId, userId],
    ),
    query(
      `select id, memory_id, event_type, actor_type, source_run_id, details, created_at
       from agent_memory_events
       where memory_id = $1 and user_id = $2
       order by id desc
       limit 200`,
      [memoryId, userId],
    ),
  ]);
  if (!memories[0]) return null;
  return { memory: memories[0], evidence, events };
};

export interface AgentMemoryScopeSetting {
  scope: AgentMemoryScope;
  enabled: boolean;
  max_active_memories: number;
  active_memory_count: number;
  candidate_memory_count: number;
  updated_at: string | null;
}

export const listAgentMemoryScopeSettings = async (userId: string) => {
  const { rows } = await query<AgentMemoryScopeSetting>(
    `with scopes(scope) as (
       values ('user'::text), ('project'::text), ('agent'::text)
     )
     select
       scopes.scope,
       coalesce(setting.enabled, true) as enabled,
       coalesce(setting.max_active_memories, 500)::integer as max_active_memories,
       count(memory.id) filter (
         where memory.status in ('candidate', 'confirmed')
           and memory.superseded_by is null
           and memory.deleted_at is null
           and (memory.expires_at is null or memory.expires_at > now())
       )::integer as active_memory_count,
       count(memory.id) filter (
         where memory.status = 'candidate'
           and memory.superseded_by is null
           and memory.deleted_at is null
           and (memory.expires_at is null or memory.expires_at > now())
       )::integer as candidate_memory_count,
       setting.updated_at
     from scopes
     left join agent_memory_scope_settings setting
       on setting.user_id = $1 and setting.scope = scopes.scope
     left join agent_memories memory
       on memory.user_id = $1 and memory.scope = scopes.scope
     group by scopes.scope, setting.enabled, setting.max_active_memories, setting.updated_at
     order by case scopes.scope when 'user' then 0 when 'project' then 1 else 2 end`,
    [userId],
  );
  return rows;
};

export const setAgentMemoryScopeEnabled = async (input: {
  userId: string;
  scope: AgentMemoryScope;
  enabled: boolean;
}) => withTransaction(async (client) => {
  await client.query(
    `select pg_advisory_xact_lock(
       hashtextextended('agent-memory-scope:' || $1::text || ':' || $2::text, 0)
     )`,
    [input.userId, input.scope],
  );
  await client.query(
    `insert into agent_memory_scope_settings (user_id, scope, enabled)
     values ($1, $2, $3)
     on conflict (user_id, scope) do update
       set enabled = excluded.enabled, updated_at = now()`,
    [input.userId, input.scope, input.enabled],
  );
  const { rows } = await client.query<AgentMemoryScopeSetting>(
    `select
       setting.scope,
       setting.enabled,
       setting.max_active_memories,
       count(memory.id) filter (
         where memory.status in ('candidate', 'confirmed')
           and memory.superseded_by is null
           and memory.deleted_at is null
           and (memory.expires_at is null or memory.expires_at > now())
       )::integer as active_memory_count,
       count(memory.id) filter (
         where memory.status = 'candidate'
           and memory.superseded_by is null
           and memory.deleted_at is null
           and (memory.expires_at is null or memory.expires_at > now())
       )::integer as candidate_memory_count,
       setting.updated_at
     from agent_memory_scope_settings setting
     left join agent_memories memory
       on memory.user_id = setting.user_id and memory.scope = setting.scope
     where setting.user_id = $1 and setting.scope = $2
     group by setting.scope, setting.enabled, setting.max_active_memories, setting.updated_at`,
    [input.userId, input.scope],
  );
  return rows[0];
});

/**
 * Cosine similarity between two vectors, or null when they are not comparable.
 *
 * Returning null rather than 0 for a mismatch matters: 0 is a legitimate
 * similarity, so conflating "orthogonal" with "cannot be compared" would let a
 * stale-dimension vector silently rank as merely irrelevant instead of being
 * excluded from ranking altogether.
 */
export const cosineSimilarity = (left: number[], right: number[]): number | null => {
  if (left.length === 0 || left.length !== right.length) return null;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return null;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
};

/**
 * Re-order candidate memories by relevance to the current request.
 *
 * Ranking happens here rather than in SQL because the vectors are plain arrays
 * and the candidate set is already bounded by scope to a few dozen rows. That
 * avoids requiring a Postgres extension on every deployment, at the cost of not
 * scaling to very large stores -- an acceptable trade while a user's memories
 * number in the tens, and a documented one.
 *
 * Memories that cannot be compared keep their deterministic order behind the
 * ranked ones, so an un-embedded memory is deprioritised but never lost.
 */
export const rankAgentMemoriesByRelevance = (
  memories: AgentMemoryRow[],
  queryEmbedding: { vector: number[]; model: string },
) => {
  const scored: { memory: AgentMemoryRow; score: number }[] = [];
  const unscored: AgentMemoryRow[] = [];
  for (const memory of memories) {
    // A vector produced by a different model is not comparable with this query.
    const comparable = memory.embedding
      && memory.embedding_model === queryEmbedding.model;
    const score = comparable
      ? cosineSimilarity(memory.embedding as number[], queryEmbedding.vector)
      : null;
    if (score === null) {
      unscored.push(memory);
      continue;
    }
    scored.push({ memory, score });
  }
  // Ties keep the incoming order, which is the trust/kind/recency ordering the
  // query already applied.
  scored.sort((left, right) => right.score - left.score);
  return [...scored.map((entry) => entry.memory), ...unscored];
};

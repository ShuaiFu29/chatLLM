import { query } from '../lib/db';

export type AgentMemoryScope = 'user' | 'project' | 'agent';
export type AgentMemoryKind = 'fact' | 'preference' | 'decision' | 'summary';
export type AgentMemorySourceTrust = 'user_stated' | 'agent_inferred' | 'tool_derived';

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
  superseded_by?: string | null;
  expires_at?: string | null;
  embedding?: number[] | null;
  embedding_model?: string | null;
  created_at: string;
  updated_at: string;
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
  superseded_by,
  expires_at,
  embedding,
  embedding_model,
  created_at,
  updated_at
`;

export const MAX_MEMORY_CONTENT_CHARS = 2_000;

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
  // The scope invariant is enforced by the schema too, but failing here gives the
  // caller a usable message instead of a constraint violation.
  const scopeRefId = input.scope === 'user' ? null : input.scopeRefId ?? null;
  if (input.scope !== 'user' && !scopeRefId) {
    throw new Error(`A ${input.scope} memory requires a scope reference`);
  }
  const { rows } = await query<AgentMemoryRow>(
    `insert into agent_memories (
       user_id, scope, scope_ref_id, kind, content, source_trust,
       provenance_run_id, provenance_step_id, expires_at, embedding, embedding_model
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::real[], $11)
     on conflict (
       user_id, scope,
       coalesce(scope_ref_id, '00000000-0000-0000-0000-000000000000'::uuid),
       kind, md5(content)
     ) where superseded_by is null
     do update set
       source_trust = excluded.source_trust,
       provenance_run_id = excluded.provenance_run_id,
       provenance_step_id = excluded.provenance_step_id,
       expires_at = excluded.expires_at,
       embedding = coalesce(excluded.embedding, agent_memories.embedding),
       embedding_model = coalesce(excluded.embedding_model, agent_memories.embedding_model),
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
    ],
  );
  return rows[0];
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
  const { rows } = await query<AgentMemoryRow>(
    `update agent_memories
     set superseded_by = $3, updated_at = now()
     where id = $2 and user_id = $1 and superseded_by is null and id <> $3
     returning ${memoryColumns}`,
    [input.userId, input.memoryId, input.supersededById],
  );
  return rows[0] || null;
};

export const forgetAgentMemory = async (userId: string, memoryId: string) => {
  const { rows } = await query<{ id: string }>(
    'delete from agent_memories where id = $1 and user_id = $2 returning id',
    [memoryId, userId],
  );
  return rows[0]?.id || null;
};

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
  limit: number;
}) => {
  const limit = Math.min(Math.max(input.limit, 1), 50);
  const { rows } = await query<AgentMemoryRow>(
    `select ${memoryColumns}
     from agent_memories
     where user_id = $1
       and superseded_by is null
       and (expires_at is null or expires_at > now())
       and (
         scope = 'user'
         or (scope = 'project' and scope_ref_id = $2::uuid)
         or (scope = 'agent' and scope_ref_id = $3::uuid)
       )
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
       created_at desc
     limit $4`,
    [input.userId, input.projectSpaceId ?? null, input.agentId ?? null, limit],
  );
  return rows;
};

export const listAgentMemoriesForUser = async (input: {
  userId: string;
  scope?: AgentMemoryScope;
  limit: number;
  offset: number;
}) => {
  const limit = Math.min(Math.max(input.limit, 1), 100);
  const { rows } = await query<AgentMemoryRow>(
    `select ${memoryColumns}
     from agent_memories
     where user_id = $1
       and ($2::text is null or scope = $2)
     order by created_at desc
     limit $3 offset $4`,
    [input.userId, input.scope ?? null, limit, Math.max(0, input.offset)],
  );
  return rows;
};

/**
 * Drop expired rows. Recall already ignores them; this keeps the table from
 * growing with content nobody will ever read again.
 */
export const deleteExpiredAgentMemories = async () => {
  const { rowCount } = await query(
    'delete from agent_memories where expires_at is not null and expires_at <= now()',
  );
  return rowCount || 0;
};

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

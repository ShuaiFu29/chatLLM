import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  deleteExpiredAgentMemories,
  decideAgentMemory,
  forgetAgentMemory,
  getAgentMemoryGovernanceForUser,
  listAgentMemoryScopeSettings,
  listAgentMemoriesForUser,
  setAgentMemoryScopeEnabled,
  supersedeAgentMemory,
  type AgentMemoryListRow,
  type AgentMemoryRow,
  type AgentMemoryScope,
  type AgentMemoryStatus,
} from '../../repositories/agentMemories';
import { recordAgentAuditEvent } from '../../repositories/agentAudit';
import {
  decodeAgentMemoryCursor,
  encodeAgentMemoryCursor,
  normalizeAgentMemorySearch,
} from '../../lib/agentMemoryCursor';
import { toSafeError } from '../../lib/safeError';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES: AgentMemoryScope[] = ['user', 'project', 'agent'];
const STATUSES: AgentMemoryStatus[] = ['candidate', 'confirmed', 'rejected'];

const publicError = (status: HttpStatus, message: string) => (
  new HttpException({ error: message }, status)
);

const readPositiveInteger = (value: unknown, fallback: number, maximum: number) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
};

const readNonNegativeInteger = (value: unknown, fallback: number, maximum: number) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
};

/**
 * Managing what an Agent has remembered about you.
 *
 * The store was built before it was reachable, which meant the system accumulated
 * facts and preferences about a user that the user could neither see nor remove.
 * That is a product gap and a data-protection one: durable personal content needs
 * an inspection and deletion path, not only a write path.
 *
 * The vector is never returned. It is an implementation detail of ranking, it is
 * large, and it is not meaningful to a reader.
 */
@Injectable()
export class AgentMemoriesService {
  private readonly toPublic = (memory: AgentMemoryRow | AgentMemoryListRow) => ({
    id: memory.id,
    scope: memory.scope,
    scope_ref_id: memory.scope_ref_id ?? null,
    kind: memory.kind,
    content: memory.content,
    source_trust: memory.source_trust,
    status: memory.status,
    verification_status: memory.verification_status,
    verified_at: memory.verified_at ?? null,
    confidence: memory.confidence,
    sensitivity: memory.sensitivity,
    last_recalled_at: memory.last_recalled_at ?? null,
    recall_count: Number(memory.recall_count),
    provenance_run_id: memory.provenance_run_id ?? null,
    provenance_agent_id: 'provenance_agent_id' in memory
      ? memory.provenance_agent_id ?? null
      : null,
    scope_ref_name: 'scope_ref_name' in memory ? memory.scope_ref_name ?? null : null,
    superseded_by: memory.superseded_by ?? null,
    deleted_at: memory.deleted_at ?? null,
    expires_at: memory.expires_at ?? null,
    // Surfaced as a boolean so a reader can tell a relevance-ranked memory from
    // one that only participates in the deterministic ordering.
    has_embedding: Boolean(memory.embedding),
    // Whether recall would still return this row. Decided here rather than in the
    // client: "deleted, superseded or expired" is the same rule the recall query
    // applies, and reimplementing it in the UI is how the two come to disagree.
    active: !memory.deleted_at
      && !memory.superseded_by
      && memory.scope_enabled !== false
      && memory.status === 'confirmed'
      && (!memory.expires_at || new Date(memory.expires_at).getTime() > Date.now()),
    created_at: memory.created_at,
    updated_at: memory.updated_at,
  });

  async list(userId: string, query: Record<string, unknown>) {
    const scope = typeof query.scope === 'string' ? query.scope : undefined;
    if (scope && !SCOPES.includes(scope as AgentMemoryScope)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid memory scope');
    }
    const status = typeof query.status === 'string' ? query.status : undefined;
    if (status && !STATUSES.includes(status as AgentMemoryStatus)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid memory status');
    }
    const limit = readPositiveInteger(query.limit, 50, 100);
    let cursor;
    let search;
    try {
      cursor = decodeAgentMemoryCursor(query.cursor);
      search = normalizeAgentMemorySearch(query.search);
    } catch (error) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        error instanceof Error ? error.message : 'Invalid Memory query',
      );
    }
    const offset = cursor ? 0 : readNonNegativeInteger(query.offset, 0, 100_000);
    const rows = await listAgentMemoriesForUser({
      userId,
      scope: scope as AgentMemoryScope | undefined,
      status: status as AgentMemoryStatus | undefined,
      search,
      cursor,
      limit: limit + 1,
      offset,
    });
    const hasMore = rows.length > limit;
    const memories = rows.slice(0, limit);
    const last = memories.at(-1);
    const nextCursor = hasMore && last
      ? encodeAgentMemoryCursor({ createdAt: last.created_at, id: last.id })
      : null;
    return {
      memories: memories.map(this.toPublic),
      limit,
      offset,
      next_cursor: nextCursor,
      // Superseded and expired rows are included here on purpose: this is the
      // inspection view, and hiding them would make it impossible to understand
      // why a recalled memory looks the way it does.
      has_more: hasMore,
    };
  }

  async get(userId: string, memoryId: string) {
    if (!UUID.test(memoryId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid memory id');
    const governance = await getAgentMemoryGovernanceForUser(memoryId, userId);
    if (!governance) throw publicError(HttpStatus.NOT_FOUND, 'Memory not found');
    return {
      memory: this.toPublic(governance.memory),
      evidence: governance.evidence,
      events: governance.events,
    };
  }

  async listScopeSettings(userId: string) {
    return { settings: await listAgentMemoryScopeSettings(userId) };
  }

  async setScopeEnabled(
    userId: string,
    body: { scope: AgentMemoryScope; enabled: boolean },
    requestId?: string,
  ) {
    const setting = await setAgentMemoryScopeEnabled({ userId, ...body });
    void recordAgentAuditEvent({
      userId,
      action: body.enabled
        ? 'agent_memory.scope_enabled'
        : 'agent_memory.scope_disabled',
      metadata: { scope: body.scope },
    }).catch((error) => {
      console.warn('[AgentMemories] scope audit failed:', toSafeError(error, requestId));
    });
    return setting;
  }

  async decide(
    userId: string,
    memoryId: string,
    body: { decision: 'confirmed' | 'rejected' },
    requestId?: string,
  ) {
    if (!UUID.test(memoryId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid memory id');
    const result = await decideAgentMemory({ userId, memoryId, decision: body.decision });
    if (result.kind === 'not_found') throw publicError(HttpStatus.NOT_FOUND, 'Memory not found');
    if (result.kind === 'conflict') {
      throw publicError(HttpStatus.CONFLICT, 'Only a pending Memory candidate can be decided');
    }
    void recordAgentAuditEvent({
      userId,
      action: body.decision === 'confirmed'
        ? 'agent_memory.confirmed'
        : 'agent_memory.rejected',
      metadata: { memory_id: memoryId },
    }).catch((error) => {
      console.warn('[AgentMemories] audit failed:', toSafeError(error, requestId));
    });
    return this.toPublic(result.memory);
  }

  async forget(userId: string, memoryId: string, requestId?: string) {
    if (!UUID.test(memoryId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid memory id');
    const removed = await forgetAgentMemory(userId, memoryId);
    if (!removed) throw publicError(HttpStatus.NOT_FOUND, 'Memory not found');
    // Deleting durable personal content is worth an audit entry even though the
    // user asked for it themselves.
    void recordAgentAuditEvent({
      userId,
      action: 'agent_memory.deleted',
      metadata: { memory_id: memoryId },
    }).catch((error) => {
      console.warn('[AgentMemories] audit failed:', toSafeError(error, requestId));
    });
    return { id: removed, deleted: true };
  }

  /**
   * Replace one memory with another rather than deleting it.
   *
   * Deleting a fact the user has changed their mind about loses the fact that it
   * ever applied. Superseding keeps the history and takes the old statement out of
   * recall, which is what the schema was built for.
   */
  async supersede(
    userId: string,
    memoryId: string,
    body: { superseded_by: string },
  ) {
    if (!UUID.test(memoryId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid memory id');
    if (!UUID.test(body.superseded_by)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid replacement memory id');
    }
    if (memoryId === body.superseded_by) {
      throw publicError(HttpStatus.BAD_REQUEST, 'A memory cannot supersede itself');
    }
    const updated = await supersedeAgentMemory({
      userId,
      memoryId,
      supersededById: body.superseded_by,
    });
    if (!updated) {
      throw publicError(
        HttpStatus.CONFLICT,
        'That memory is missing or has already been superseded',
      );
    }
    return this.toPublic(updated);
  }

  /** Exposed for the maintenance task; recall already ignores expired rows. */
  async purgeExpired() {
    return { removed: await deleteExpiredAgentMemories() };
  }
}

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  deleteExpiredAgentMemories,
  forgetAgentMemory,
  listAgentMemoriesForUser,
  supersedeAgentMemory,
  type AgentMemoryRow,
  type AgentMemoryScope,
} from '../../repositories/agentMemories';
import { recordAgentAuditEvent } from '../../repositories/agentAudit';
import { toSafeError } from '../../lib/safeError';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES: AgentMemoryScope[] = ['user', 'project', 'agent'];

const publicError = (status: HttpStatus, message: string) => (
  new HttpException({ error: message }, status)
);

const readPositiveInteger = (value: unknown, fallback: number, maximum: number) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
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
  private readonly toPublic = (memory: AgentMemoryRow) => ({
    id: memory.id,
    scope: memory.scope,
    scope_ref_id: memory.scope_ref_id ?? null,
    kind: memory.kind,
    content: memory.content,
    source_trust: memory.source_trust,
    provenance_run_id: memory.provenance_run_id ?? null,
    superseded_by: memory.superseded_by ?? null,
    expires_at: memory.expires_at ?? null,
    // Surfaced as a boolean so a reader can tell a relevance-ranked memory from
    // one that only participates in the deterministic ordering.
    has_embedding: Boolean(memory.embedding),
    // Whether recall would still return this row. Decided here rather than in the
    // client: "superseded or expired" is the same rule the recall query applies,
    // and reimplementing it in the UI is how the two come to disagree.
    active: !memory.superseded_by
      && (!memory.expires_at || new Date(memory.expires_at).getTime() > Date.now()),
    created_at: memory.created_at,
    updated_at: memory.updated_at,
  });

  async list(userId: string, query: Record<string, unknown>) {
    const scope = typeof query.scope === 'string' ? query.scope : undefined;
    if (scope && !SCOPES.includes(scope as AgentMemoryScope)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid memory scope');
    }
    const limit = readPositiveInteger(query.limit, 50, 100);
    const offset = Math.max(0, Number(query.offset) || 0);
    const memories = await listAgentMemoriesForUser({
      userId,
      scope: scope as AgentMemoryScope | undefined,
      limit,
      offset,
    });
    return {
      memories: memories.map(this.toPublic),
      limit,
      offset,
      // Superseded and expired rows are included here on purpose: this is the
      // inspection view, and hiding them would make it impossible to understand
      // why a recalled memory looks the way it does.
      has_more: memories.length === limit,
    };
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

export interface AgentMemoryCursor {
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

const invalidCursor = (): never => {
  throw new Error('Invalid Agent Memory cursor');
};

/**
 * Encode the final `(created_at, id)` tuple of a page without exposing SQL
 * syntax or accepting client-selected sort keys on the next request.
 */
export const encodeAgentMemoryCursor = (cursor: AgentMemoryCursor) => Buffer
  .from(JSON.stringify({ created_at: cursor.createdAt, id: cursor.id }), 'utf8')
  .toString('base64url');

export const decodeAgentMemoryCursor = (value: unknown): AgentMemoryCursor | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !CURSOR.test(value)) invalidCursor();
  const encoded = value as string;
  let decoded = '';
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) invalidCursor();
  } catch {
    invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    invalidCursor();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidCursor();
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'created_at,id'
    || typeof record.created_at !== 'string'
    || !Number.isFinite(Date.parse(record.created_at))
    || typeof record.id !== 'string'
    || !UUID.test(record.id)
  ) invalidCursor();
  return { createdAt: record.created_at as string, id: record.id as string };
};

export const normalizeAgentMemorySearch = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('Invalid Agent Memory search');
  const search = value.trim();
  if (!search) return undefined;
  if (search.length > 200) throw new Error('Agent Memory search is too long');
  return search;
};

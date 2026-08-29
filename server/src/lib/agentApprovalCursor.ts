export interface AgentApprovalCursor {
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

export class AgentApprovalCursorError extends Error {
  constructor() {
    super('Invalid Agent approval cursor');
    this.name = 'AgentApprovalCursorError';
  }
}

const invalidCursor = (): never => {
  throw new AgentApprovalCursorError();
};

export const encodeAgentApprovalCursor = (cursor: AgentApprovalCursor) => Buffer
  .from(JSON.stringify({ created_at: cursor.createdAt, id: cursor.id }), 'utf8')
  .toString('base64url');

export const decodeAgentApprovalCursor = (value: unknown): AgentApprovalCursor | null => {
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

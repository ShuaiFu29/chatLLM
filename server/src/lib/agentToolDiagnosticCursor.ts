export interface AgentToolDiagnosticCursor {
  checkedAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

export class AgentToolDiagnosticCursorError extends Error {
  constructor() {
    super('Invalid Agent tool diagnostic cursor');
    this.name = 'AgentToolDiagnosticCursorError';
  }
}

const invalidCursor = (): never => {
  throw new AgentToolDiagnosticCursorError();
};

export const encodeAgentToolDiagnosticCursor = (
  cursor: AgentToolDiagnosticCursor,
) => Buffer
  .from(JSON.stringify({ checked_at: cursor.checkedAt, id: cursor.id }), 'utf8')
  .toString('base64url');

export const decodeAgentToolDiagnosticCursor = (
  value: unknown,
): AgentToolDiagnosticCursor | null => {
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
    Object.keys(record).sort().join(',') !== 'checked_at,id'
    || typeof record.checked_at !== 'string'
    || !Number.isFinite(Date.parse(record.checked_at))
    || typeof record.id !== 'string'
    || !UUID.test(record.id)
  ) invalidCursor();
  return {
    checkedAt: record.checked_at as string,
    id: record.id as string,
  };
};

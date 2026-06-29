import type { MessageRow } from '../repositories/messages';

export const DEFAULT_MESSAGE_PAGE_LIMIT = 100;
export const MAX_MESSAGE_PAGE_LIMIT = 200;
const MAX_CURSOR_LENGTH = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MessageCursor {
  id: string;
  createdAt: string;
}

export type MessagePageQuery =
  | { ok: true; limit: number; cursor: MessageCursor | null }
  | { ok: false; statusCode: number; error: string };

const readSingleQueryValue = (value: unknown) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const normalizeTimestamp = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

export const encodeMessageCursor = (message: Pick<MessageRow, 'id' | 'created_at'>) => {
  const payload = JSON.stringify({
    id: message.id,
    createdAt: normalizeTimestamp(message.created_at),
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
};

export const decodeMessageCursor = (value: unknown): MessageCursor | null => {
  const raw = readSingleQueryValue(value);
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_CURSOR_LENGTH) return null;

  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const payload = JSON.parse(decoded) as Partial<MessageCursor>;
    const createdAt = normalizeTimestamp(payload.createdAt);
    const id = typeof payload.id === 'string' && UUID_PATTERN.test(payload.id) ? payload.id : null;

    if (!id || !createdAt) return null;
    return { id, createdAt };
  } catch {
    return null;
  }
};

export const normalizeMessagePageQuery = (query: Record<string, unknown>): MessagePageQuery => {
  const rawLimit = readSingleQueryValue(query.limit);
  let limit = DEFAULT_MESSAGE_PAGE_LIMIT;

  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit.trim())) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Message page limit must be a positive integer',
      };
    }

    const parsedLimit = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Message page limit must be a positive integer',
      };
    }

    limit = Math.min(parsedLimit, MAX_MESSAGE_PAGE_LIMIT);
  }

  const rawCursor = readSingleQueryValue(query.cursor);
  if (rawCursor === undefined || rawCursor === '') {
    return { ok: true, limit, cursor: null };
  }

  const cursor = decodeMessageCursor(rawCursor);
  if (!cursor) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Invalid message cursor',
    };
  }

  return { ok: true, limit, cursor };
};

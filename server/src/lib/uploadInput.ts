export const MAX_UPLOAD_CHUNKS = 1000;
const DOCUMENT_CONTENT_TYPES = new Map([
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
]);

export const SUPPORTED_DOCUMENT_ERROR = 'Only Markdown files (.md, .markdown) are supported';

const parseBoundedInteger = (
  value: unknown,
  min: number,
  max: number
): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return null;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;

  return parsed;
};

export const parseUploadChunkIndex = (value: unknown) =>
  parseBoundedInteger(value, 0, MAX_UPLOAD_CHUNKS - 1);

export const parseUploadTotalChunks = (value: unknown) =>
  parseBoundedInteger(value, 1, MAX_UPLOAD_CHUNKS);

export const getSupportedDocumentContentType = (filename: unknown): string | null => {
  if (typeof filename !== 'string') return null;

  const normalized = filename.trim().toLowerCase();
  for (const [extension, contentType] of DOCUMENT_CONTENT_TYPES.entries()) {
    if (normalized.endsWith(extension)) return contentType;
  }

  return null;
};

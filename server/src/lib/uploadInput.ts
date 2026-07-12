export const MAX_UPLOAD_CHUNKS = 1000;
export const MIN_MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const MAX_MULTIPART_UPLOAD_PARTS = 10000;
export const MAX_MULTIPART_PRESIGN_PARTS = 100;
export const UPLOAD_HASH_ERROR = 'A valid SHA-256 file hash is required';
export const UPLOAD_SIZE_ERROR = 'A valid file size is required';
export const UPLOAD_TOO_LARGE_ERROR = 'Document exceeds the maximum allowed size';

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

export const parseUploadFileHash = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
};

export const parseUploadFileSize = (
  value: unknown,
  maxBytes = Number.MAX_SAFE_INTEGER
): number | null => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
  return parseBoundedInteger(value, 1, maxBytes);
};

export const chooseMultipartPartSize = (
  fileSize: number,
  preferredPartSize = DEFAULT_MULTIPART_PART_SIZE_BYTES
) => {
  const safeFileSize = Math.max(1, Math.floor(fileSize));
  const safePreferred = Math.max(MIN_MULTIPART_PART_SIZE_BYTES, Math.floor(preferredPartSize));
  const requiredPartSize = Math.ceil(safeFileSize / MAX_MULTIPART_UPLOAD_PARTS);
  return Math.max(safePreferred, requiredPartSize, MIN_MULTIPART_PART_SIZE_BYTES);
};

export const parseMultipartPartNumbers = (value: unknown): number[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MULTIPART_PRESIGN_PARTS) {
    return null;
  }

  const parsed = value.map((item) => parseBoundedInteger(item, 1, MAX_MULTIPART_UPLOAD_PARTS));
  if (parsed.some((item) => item === null)) return null;

  return Array.from(new Set(parsed as number[])).sort((a, b) => a - b);
};

export const getSupportedDocumentContentType = (filename: unknown): string | null => {
  if (typeof filename !== 'string') return null;

  const normalized = filename.trim().toLowerCase();
  for (const [extension, contentType] of DOCUMENT_CONTENT_TYPES.entries()) {
    if (normalized.endsWith(extension)) return contentType;
  }

  return null;
};

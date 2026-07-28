import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const MAX_UPLOAD_CHUNKS = 1000;
export const MIN_MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const MAX_MULTIPART_UPLOAD_PARTS = 10000;
export const MAX_MULTIPART_PRESIGN_PARTS = 100;
export const UPLOAD_HASH_ERROR = 'A valid SHA-256 file hash is required';
export const UPLOAD_SIZE_ERROR = 'A valid file size is required';
export const UPLOAD_TOO_LARGE_ERROR = 'Document exceeds the maximum allowed size';

export type DocumentKind =
  | 'markdown'
  | 'plaintext'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'csv';

export interface DocumentTypeCapability {
  readonly documentKind: DocumentKind;
  readonly extensions: readonly string[];
  readonly canonicalMimeType: string;
  readonly acceptedMimeTypes: readonly string[];
  readonly maxBytes: number;
  readonly conversionProfile: string;
}

export interface DocumentTypeRegistry {
  readonly schemaVersion: number;
  readonly documentTypes: readonly DocumentTypeCapability[];
}

const DOCUMENT_KINDS = new Set<DocumentKind>([
  'markdown',
  'plaintext',
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'csv',
]);

const registryCandidates = [
  path.resolve(__dirname, '..', 'shared', 'document-types.json'),
  path.resolve(process.cwd(), 'shared', 'document-types.json'),
  path.resolve(process.cwd(), '..', 'shared', 'document-types.json'),
  path.resolve(__dirname, '..', '..', '..', 'shared', 'document-types.json'),
];

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const readDocumentTypeRegistry = (): DocumentTypeRegistry => {
  const registryPath = registryCandidates.find((candidate) => existsSync(candidate));
  if (!registryPath) {
    throw new Error('Document type registry could not be found');
  }

  const parsed: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Document type registry must be an object');
  }

  const candidate = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.schemaVersion) || (candidate.schemaVersion as number) < 1) {
    throw new Error('Document type registry schemaVersion must be a positive integer');
  }
  if (!Array.isArray(candidate.documentTypes) || candidate.documentTypes.length === 0) {
    throw new Error('Document type registry must contain documentTypes');
  }

  const seenExtensions = new Set<string>();
  const documentTypes = candidate.documentTypes.map((item, index): DocumentTypeCapability => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Document type registry entry ${index} must be an object`);
    }

    const entry = item as Record<string, unknown>;
    if (!isNonEmptyString(entry.documentKind) || !DOCUMENT_KINDS.has(entry.documentKind as DocumentKind)) {
      throw new Error(`Document type registry entry ${index} has an unsupported documentKind`);
    }
    if (!Array.isArray(entry.extensions) || entry.extensions.length === 0) {
      throw new Error(`Document type registry entry ${index} must contain extensions`);
    }
    if (!isNonEmptyString(entry.canonicalMimeType)) {
      throw new Error(`Document type registry entry ${index} must contain canonicalMimeType`);
    }
    if (!Array.isArray(entry.acceptedMimeTypes) || !entry.acceptedMimeTypes.every(isNonEmptyString)) {
      throw new Error(`Document type registry entry ${index} must contain acceptedMimeTypes`);
    }
    if (!Number.isSafeInteger(entry.maxBytes) || (entry.maxBytes as number) < 1) {
      throw new Error(`Document type registry entry ${index} must contain a positive maxBytes`);
    }
    if (!isNonEmptyString(entry.conversionProfile)) {
      throw new Error(`Document type registry entry ${index} must contain conversionProfile`);
    }

    const extensions = entry.extensions.map((extension) => {
      if (!isNonEmptyString(extension) || !/^[a-z0-9]+$/.test(extension)) {
        throw new Error(`Document type registry entry ${index} contains an invalid extension`);
      }
      if (seenExtensions.has(extension)) {
        throw new Error(`Document type registry contains duplicate extension: ${extension}`);
      }
      seenExtensions.add(extension);
      return extension;
    });

    return Object.freeze({
      documentKind: entry.documentKind as DocumentKind,
      extensions: Object.freeze(extensions),
      canonicalMimeType: entry.canonicalMimeType,
      acceptedMimeTypes: Object.freeze([...entry.acceptedMimeTypes]),
      maxBytes: entry.maxBytes as number,
      conversionProfile: entry.conversionProfile,
    });
  });

  return Object.freeze({
    schemaVersion: candidate.schemaVersion as number,
    documentTypes: Object.freeze(documentTypes),
  });
};

export const DOCUMENT_TYPE_REGISTRY = readDocumentTypeRegistry();
export const DOCUMENT_TYPE_CAPABILITIES = DOCUMENT_TYPE_REGISTRY.documentTypes;

const DOCUMENT_TYPES_BY_EXTENSION = new Map<string, DocumentTypeCapability>(
  DOCUMENT_TYPE_CAPABILITIES.flatMap((documentType) =>
    documentType.extensions.map((extension) => [extension, documentType] as const)
  )
);

const SUPPORTED_EXTENSIONS = Array.from(DOCUMENT_TYPES_BY_EXTENSION.keys());

export const SUPPORTED_DOCUMENT_ERROR =
  `Only supported document files (${SUPPORTED_EXTENSIONS.map((extension) => `.${extension}`).join(', ')}) are allowed`;

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
  return getSupportedDocumentType(filename)?.canonicalMimeType ?? null;
};

export const getSupportedDocumentType = (filename: unknown): DocumentTypeCapability | null => {
  if (typeof filename !== 'string') return null;

  const normalized = filename.trim().toLowerCase();
  const extensionStart = normalized.lastIndexOf('.');
  if (extensionStart < 0 || extensionStart === normalized.length - 1) return null;

  return DOCUMENT_TYPES_BY_EXTENSION.get(normalized.slice(extensionStart + 1)) ?? null;
};

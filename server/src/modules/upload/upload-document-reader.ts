import { HttpException, StreamableFile } from '@nestjs/common';
import { httpResponse } from '../../common/http/http-response';
import { toSafeError } from '../../lib/safeError';
import {
  buildContentDisposition,
  buildDerivedMarkdownFilename,
  getObjectStream,
  isObjectNotFoundError,
} from '../../lib/storage';
import { DOCUMENT_TYPE_REGISTRY } from '../../lib/uploadInput';
import {
  type FileRow,
  findActiveConvertedFileContentForUser,
  findFileForUser,
} from '../../repositories/files';

export interface DocumentReadDependencies {
  findActiveContent: typeof findActiveConvertedFileContentForUser;
  findOriginal: typeof findFileForUser;
  openObject: typeof getObjectStream;
}

const defaultDependencies: DocumentReadDependencies = {
  findActiveContent: findActiveConvertedFileContentForUser,
  findOriginal: findFileForUser,
  openObject: getObjectStream,
};

const withDependencies = (
  overrides: Partial<DocumentReadDependencies>,
): DocumentReadDependencies => ({
  ...defaultDependencies,
  ...overrides,
});

const requestError = (status: number, error: string) => (
  new HttpException({ error }, status)
);

const readMimeType = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase() || '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)
    ? mimeType
    : null;
};

export const resolveOriginalDocumentContentType = (
  file: Pick<
    FileRow,
    'status' | 'document_kind' | 'detected_mime_type' | 'file_type'
  >,
  storedContentType?: string,
) => {
  const capability = DOCUMENT_TYPE_REGISTRY.documentTypes.find(
    (documentType) => documentType.documentKind === file.document_kind,
  );
  if (!capability) return 'application/octet-stream';

  const acceptedMimeTypes = new Set([
    capability.canonicalMimeType,
    ...capability.acceptedMimeTypes,
  ].map((mimeType) => mimeType.toLowerCase()));
  const readAcceptedMimeType = (value: unknown) => {
    const mimeType = readMimeType(value);
    return mimeType && acceptedMimeTypes.has(mimeType) ? mimeType : null;
  };

  const detectedMimeType = readAcceptedMimeType(file.detected_mime_type);
  if (detectedMimeType) return detectedMimeType;

  // Until conversion has validated the original, do not trust its extension,
  // declared MIME type, or object metadata as an inline-capable response type.
  if (file.status !== 'completed') return 'application/octet-stream';
  return readAcceptedMimeType(storedContentType)
    || readAcceptedMimeType(file.file_type)
    || 'application/octet-stream';
};

const markdownEtag = (value: unknown) => {
  const hash = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{64}$/.test(hash) ? `"${hash}"` : null;
};

export const readDerivedDocumentContent = async (
  userId: string,
  id: string,
  requestId?: string,
  dependencyOverrides: Partial<DocumentReadDependencies> = {},
) => {
  const dependencies = withDependencies(dependencyOverrides);
  let content;
  try {
    content = await dependencies.findActiveContent(id, userId);
  } catch (error) {
    console.warn('[Upload] File content lookup failed:', toSafeError(error, requestId));
    throw requestError(503, 'File content is unavailable');
  }
  if (!content) throw requestError(404, 'File content not found');

  try {
    const { stream } = await dependencies.openObject(content.markdown_object_key);
    const etag = markdownEtag(content.markdown_hash);
    return httpResponse(new StreamableFile(stream), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': buildContentDisposition(
          'inline',
          buildDerivedMarkdownFilename(content.filename),
        ),
        'Cache-Control': 'private, max-age=60',
        'X-Content-Type-Options': 'nosniff',
        ...(etag ? { ETag: etag } : {}),
      },
    });
  } catch (error) {
    if (isObjectNotFoundError(error)) throw requestError(404, 'File content not found');
    console.warn('[Upload] File content lookup failed:', toSafeError(error, requestId));
    throw requestError(503, 'File content is unavailable');
  }
};

export const readOriginalDocument = async (
  userId: string,
  id: string,
  requestId?: string,
  dependencyOverrides: Partial<DocumentReadDependencies> = {},
) => {
  const dependencies = withDependencies(dependencyOverrides);
  let file;
  try {
    file = await dependencies.findOriginal(id, userId);
  } catch (error) {
    console.warn('[Upload] File original lookup failed:', toSafeError(error, requestId));
    throw requestError(503, 'File original is unavailable');
  }
  if (!file || !file.object_key || ['uploading', 'deleting'].includes(file.status)) {
    throw requestError(404, 'File original not found');
  }

  try {
    const object = await dependencies.openObject(file.object_key);
    return httpResponse(new StreamableFile(object.stream), {
      headers: {
        'Content-Type': resolveOriginalDocumentContentType(file, object.contentType),
        'Content-Disposition': buildContentDisposition('attachment', file.filename),
        'Cache-Control': 'private, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (isObjectNotFoundError(error)) throw requestError(404, 'File original not found');
    console.warn('[Upload] File original lookup failed:', toSafeError(error, requestId));
    throw requestError(503, 'File original is unavailable');
  }
};

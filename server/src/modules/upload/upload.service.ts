import path from 'path';
import fs from 'fs-extra';
import { pipeline } from 'stream/promises';
import { HttpException, Injectable, StreamableFile } from '@nestjs/common';
import { BufferedUpload } from '../../common/http/app-request';
import { httpResponse } from '../../common/http/http-response';
import { toSafeError } from '../../lib/safeError';
import {
  abortMultipartObjectUpload,
  buildAvatarKey,
  buildContentDisposition,
  buildDerivedMarkdownFilename,
  buildDocumentKey,
  completeMultipartObjectUpload,
  createMultipartObjectUpload,
  deleteObject,
  getObjectStream,
  headObjectMetadata,
  isMultipartUploadMissingError,
  isObjectNotFoundError,
  isStorageClientError,
  listMultipartObjectParts,
  presignMultipartUploadParts,
  uploadBuffer,
  uploadFilePath,
} from '../../lib/storage';
import {
  type FileRow,
  findClaimedFileByUserAndHash,
  findActiveConvertedFileContentForUser,
  findFileForUser,
  listFilesForUser,
  reserveUploadFile,
  retryFailedFileForUser,
  updateFile,
} from '../../repositories/files';
import { enqueueAvatarCleanup, enqueueFileCleanup } from '../../repositories/cleanupJobs';
import {
  ensureDefaultProjectSpaceForUser,
  findProjectSpaceForUser,
} from '../../repositories/projectSpaces';
import { findUserById, replaceUserAvatar } from '../../repositories/users';
import {
  type MultipartUploadSessionRow,
  claimMultipartUploadAbort,
  claimMultipartUploadCompletion,
  createMultipartUploadSession,
  finalizeMultipartUploadAbort,
  finalizeMultipartUploadCompletion,
  finalizeMultipartUploadFailure,
  findActiveMultipartUploadSession,
  findMultipartUploadSessionForUser,
  markMultipartUploadAbortRetryable,
  markMultipartUploadCompletionRetryable,
  markMultipartUploadSessionUploading,
  reclaimMultipartUploadCompletion,
  releaseMultipartUploadCompletion,
} from '../../repositories/uploadMultipart';
import { fileQueue } from '../../services/fileQueue';
import { artifactCleanupQueue } from '../../services/cleanupQueue';
import { verifyMergedUploadFile } from '../../lib/uploadIntegrity';
import { assertCompletedMultipartObject } from '../../lib/multipartCompletion';
import {
  DOCUMENT_TYPE_REGISTRY,
  MAX_MULTIPART_UPLOAD_PARTS,
  SUPPORTED_DOCUMENT_ERROR,
  UPLOAD_HASH_ERROR,
  UPLOAD_SIZE_ERROR,
  UPLOAD_TOO_LARGE_ERROR,
  chooseMultipartPartSize,
  getSupportedDocumentType,
  parseMultipartPartNumbers,
  parseUploadFileHash,
  parseUploadFileSize,
  parseUploadChunkIndex,
  parseUploadTotalChunks,
} from '../../lib/uploadInput';
import { serverEnv } from '../../lib/env';
import { DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES } from '../../lib/uploadLimits';

const UPLOAD_DIR = path.join(__dirname, '../../../uploads/temp');
fs.ensureDirSync(UPLOAD_DIR);

const readErrorMessage = (error: unknown) => error instanceof Error ? error.message : '';

const getUploadInputMessage = (error: unknown): string | null => {
  const message = readErrorMessage(error);
  if (message.includes(SUPPORTED_DOCUMENT_ERROR)) return SUPPORTED_DOCUMENT_ERROR;
  if (message.includes(UPLOAD_HASH_ERROR)) return UPLOAD_HASH_ERROR;
  if (message.includes(UPLOAD_SIZE_ERROR)) return UPLOAD_SIZE_ERROR;
  if (message.includes(UPLOAD_TOO_LARGE_ERROR)) return UPLOAD_TOO_LARGE_ERROR;
  return null;
};

const uploadReservationFailures = {
  DOCUMENT_TOO_LARGE: { status: 413, message: UPLOAD_TOO_LARGE_ERROR },
  USER_STORAGE_QUOTA_EXCEEDED: { status: 413, message: 'User storage quota exceeded' },
  ACTIVE_UPLOAD_QUOTA_EXCEEDED: { status: 413, message: 'Active upload quota exceeded' },
  UPLOAD_USER_NOT_FOUND: { status: 409, message: 'Account is unavailable' },
  UPLOAD_PROJECT_NOT_FOUND: { status: 404, message: 'Project space not found' },
} as const;

const getUploadReservationFailure = (error: unknown) => {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = error.code;
  if (typeof code !== 'string' || !(code in uploadReservationFailures)) return null;
  return uploadReservationFailures[code as keyof typeof uploadReservationFailures];
};

const isMultipartUploadUnavailableError = (error: unknown) => Boolean(
  error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'MULTIPART_UPLOAD_UNAVAILABLE'
);

const getUploadFailureStatus = (
  inputMessage: string | null,
  reservationFailure: ReturnType<typeof getUploadReservationFailure>
) => {
  if (reservationFailure) return reservationFailure.status;
  if (inputMessage === UPLOAD_TOO_LARGE_ERROR) return 413;
  return inputMessage ? 400 : 500;
};

const getMultipartCompletionMessage = (error: unknown): string | null => {
  const message = readErrorMessage(error);
  if (message.startsWith('Missing uploaded parts.')) return 'Missing uploaded parts';
  if (/^Missing uploaded part \d+$/.test(message)) return 'Missing uploaded part';
  if (message.startsWith('Uploaded multipart object size mismatch:')) {
    return 'Uploaded multipart object size mismatch';
  }
  if (message.startsWith('Uploaded multipart part size mismatch:')) {
    return 'Uploaded multipart part size mismatch';
  }
  if (message === 'Multipart upload session expired') return message;
  return null;
};

const getCompletedMultipartIntegrityMessage = (error: unknown): string | null => {
  const message = readErrorMessage(error);
  if (message.startsWith('Completed multipart object size mismatch:')
    || message === 'Completed multipart object hash metadata mismatch'
    || message === 'Completed multipart object size metadata mismatch') {
    return 'Completed multipart object integrity mismatch';
  }
  return null;
};

const getMergeIntegrityMessage = (error: unknown): string | null => {
  const message = readErrorMessage(error);
  if (message.startsWith('Merged upload hash mismatch:')) return 'Merged upload hash mismatch';
  if (message.startsWith('Merged upload size mismatch:')) return 'Merged upload size mismatch';
  return null;
};

const uploadError = (
  requestId: string | undefined,
  status: number,
  publicMessage: string,
  error: unknown,
  operation: string
) => {
  if (status >= 500) {
    console.error('[Upload] operation failed:', {
      operation,
      error: toSafeError(error, requestId),
    });
  }
  return httpResponse(
    { error: publicMessage, details: publicMessage },
    { statusCode: status },
  );
};

const requestError = (status: number, error: string) => (
  new HttpException({ error }, status)
);

const errorResponse = (statusCode: number, error: string) => (
  httpResponse({ error }, { statusCode })
);

export interface DocumentReadDependencies {
  findActiveContent: typeof findActiveConvertedFileContentForUser;
  findOriginal: typeof findFileForUser;
  openObject: typeof getObjectStream;
}

const defaultDocumentReadDependencies: DocumentReadDependencies = {
  findActiveContent: findActiveConvertedFileContentForUser,
  findOriginal: findFileForUser,
  openObject: getObjectStream,
};

const documentReadDependencies = (
  overrides: Partial<DocumentReadDependencies>,
): DocumentReadDependencies => ({
  ...defaultDocumentReadDependencies,
  ...overrides,
});

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

export interface UploadBody {
  hash?: string;
  filename?: string;
  size?: number;
  type?: string;
  project_space_id?: string;
  projectSpaceId?: string;
  uploadId?: string;
  partNumbers?: number[];
  part_numbers?: number[];
  chunkIndex?: string;
  totalChunks?: number;
}

export interface UploadQuery {
  projectSpaceId?: string;
  project_space_id?: string;
}

const ensureSupportedDocument = (filename?: string) => {
  const documentType = getSupportedDocumentType(filename);
  if (!documentType) {
    throw new Error(SUPPORTED_DOCUMENT_ERROR);
  }
  return documentType;
};

const ensureSupportedDocumentFilename = (filename?: string) => (
  ensureSupportedDocument(filename).canonicalMimeType
);

const requireUploadHash = (value: unknown) => {
  const hash = parseUploadFileHash(value);
  if (!hash) throw new Error(UPLOAD_HASH_ERROR);
  return hash;
};

const requireUploadSize = (value: unknown, typeMaximumBytes = serverEnv.MAX_DOCUMENT_BYTES) => {
  const maximumBytes = Math.min(serverEnv.MAX_DOCUMENT_BYTES, typeMaximumBytes);
  const size = parseUploadFileSize(value, maximumBytes);
  if (size === null && parseUploadFileSize(value) !== null) {
    throw new Error(UPLOAD_TOO_LARGE_ERROR);
  }
  if (size === null) throw new Error(UPLOAD_SIZE_ERROR);
  return size;
};

const needsFileBytes = (file: { status: string; object_key?: string | null }) => (
  file.status === 'uploading' && !file.object_key
);

const readProjectSpaceId = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const resolveProjectSpaceId = async (userId: string, requestedProjectSpaceId?: string) => {
  if (requestedProjectSpaceId) {
    const space = await findProjectSpaceForUser(requestedProjectSpaceId, userId);
    if (!space) return null;
    return space.id;
  }

  const defaultSpace = await ensureDefaultProjectSpaceForUser(userId);
  return defaultSpace.id;
};

const normalizeStorageParts = (parts: Array<{ partNumber: number; etag: string; size?: number }>) =>
  parts
    .filter((part) => part.partNumber >= 1 && part.partNumber <= MAX_MULTIPART_UPLOAD_PARTS && part.etag)
    .sort((a, b) => a.partNumber - b.partNumber);

const sendExistingMultipartSession = async (
  session: MultipartUploadSessionRow,
  fileId: string,
  projectSpaceId: string
) => {
  if (session.status === 'completed') {
    return {
      exists: true,
      uploadNeeded: false,
      uploadId: fileId,
      projectSpaceId,
    };
  }
  if (session.status === 'completing') {
    return errorResponse(409, 'Multipart upload completion is in progress');
  }
  if (session.status === 'cancelling') {
    return errorResponse(409, 'Multipart upload cancellation is pending');
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    return errorResponse(410, 'Multipart upload cleanup is pending');
  }

  const uploadedParts = await listMultipartObjectParts(
    session.object_key,
    session.storage_upload_id
  ).catch(() => []);
  return {
    exists: false,
    uploadNeeded: true,
    uploadStrategy: 'direct-multipart',
    uploadId: fileId,
    partSize: Number(session.part_size),
    totalParts: Number(session.total_parts),
    uploadedPartNumbers: normalizeStorageParts(uploadedParts).map((part) => part.partNumber),
    expiresAt: session.expires_at,
    projectSpaceId,
  };
};

const assertCompletePartSet = (
  parts: Array<{ partNumber: number; etag: string; size?: number }>,
  expectedTotalParts: number,
  expectedFileSize?: number | null,
  expectedPartSize?: number | null
) => {
  if (parts.length !== expectedTotalParts) {
    throw new Error(`Missing uploaded parts. Expected ${expectedTotalParts}, found ${parts.length}`);
  }

  for (let index = 0; index < expectedTotalParts; index += 1) {
    const expectedPartNumber = index + 1;
    if (parts[index]?.partNumber !== expectedPartNumber) {
      throw new Error(`Missing uploaded part ${expectedPartNumber}`);
    }
  }

  const partSizes = parts.map((part) => Number(part.size));
  if (!partSizes.every((size) => Number.isSafeInteger(size) && size >= 0)) {
    throw new Error('Uploaded multipart object size could not be verified');
  }
  const uploadedSize = partSizes.reduce((sum, size) => sum + size, 0);

  if (expectedFileSize !== undefined && expectedFileSize !== null
    && expectedPartSize !== undefined && expectedPartSize !== null) {
    const fileSize = Number(expectedFileSize);
    const partSize = Number(expectedPartSize);
    for (let index = 0; index < expectedTotalParts; index += 1) {
      const expectedSize = Math.min(partSize, fileSize - (index * partSize));
      if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || partSizes[index] !== expectedSize) {
        throw new Error(
          `Uploaded multipart part size mismatch: part ${index + 1} expected ${expectedSize}, got ${partSizes[index]}`
        );
      }
    }
  }

  if (expectedFileSize !== undefined && expectedFileSize !== null && uploadedSize !== Number(expectedFileSize)) {
    throw new Error(`Uploaded multipart object size mismatch: expected ${expectedFileSize}, got ${uploadedSize}`);
  }

  return uploadedSize;
};

const inspectCompletedMultipartObject = async (
  session: MultipartUploadSessionRow,
  upload: Pick<FileRow, 'file_hash' | 'file_size'>
) => {
  try {
    const object = await headObjectMetadata(session.object_key);
    return {
      exists: true as const,
      storageBytes: assertCompletedMultipartObject(object, upload),
    };
  } catch (error) {
    if (isObjectNotFoundError(error)) {
      return { exists: false as const, storageBytes: null };
    }
    throw error;
  }
};

const multipartCompleteSuccess = () => ({
  success: true,
  message: 'File uploaded and queued for processing',
});

const MULTIPART_COMPLETION_RETRYABLE = 'Multipart completion is pending reconciliation';
const MULTIPART_ABORT_RETRYABLE = 'Multipart abort is pending reconciliation';
const MULTIPART_UPLOAD_MISSING = 'Multipart upload no longer exists';
const MULTIPART_COMPLETION_REJECTED = 'Multipart completion was rejected by storage';

@Injectable()
export class UploadService {
  getDocumentCapabilities() {
    return DOCUMENT_TYPE_REGISTRY;
  }

  async checkFile(userId: string, body: UploadBody, requestId?: string) {
    const { hash, filename } = body;

    try {
      const normalizedHash = requireUploadHash(hash);
      const documentType = ensureSupportedDocument(filename);
      const requestedProjectSpaceId = readProjectSpaceId(body.project_space_id ?? body.projectSpaceId);
      const projectSpaceId = await resolveProjectSpaceId(userId, requestedProjectSpaceId);
      if (!projectSpaceId) return errorResponse(404, 'Project space not found');

      const claimedFile = await findClaimedFileByUserAndHash(
        userId,
        normalizedHash,
        projectSpaceId,
        documentType.conversionProfile,
      );

      if (claimedFile && !needsFileBytes(claimedFile)) {
        return {
          exists: true,
          uploadNeeded: false,
          fileId: claimedFile.id,
          projectSpaceId,
        };
      }

      const fileId = claimedFile?.status === 'uploading' ? claimedFile.id : undefined;
      let uploadedChunks: number[] = [];
      let multipartSession = null;

      if (fileId) {
        const activeSession = await findActiveMultipartUploadSession(fileId, userId);
        if (activeSession) {
          if (activeSession.status === 'completing') {
            return errorResponse(409, 'Multipart upload completion is in progress');
          }
          if (activeSession.status === 'cancelling') {
            return errorResponse(409, 'Multipart upload cancellation is pending');
          }
          if (new Date(activeSession.expires_at).getTime() <= Date.now()) {
            return errorResponse(410, 'Multipart upload cleanup is pending');
          }
          const uploadedParts = await listMultipartObjectParts(activeSession.object_key, activeSession.storage_upload_id)
            .catch(() => []);
          multipartSession = {
            uploadId: fileId,
            partSize: Number(activeSession.part_size),
            totalParts: Number(activeSession.total_parts),
            uploadedPartNumbers: normalizeStorageParts(uploadedParts).map((part) => part.partNumber),
            expiresAt: activeSession.expires_at,
          };
        }

        // fileId is a database UUID owned by the authenticated user, not request path input.
        const fileDir = path.join(UPLOAD_DIR, fileId); // nosemgrep
        if (await fs.pathExists(fileDir)) {
          const files = await fs.readdir(fileDir);
          uploadedChunks = files.map((file) => Number.parseInt(file, 10)).filter((n) => !Number.isNaN(n));
        }
      }

      return {
        exists: false,
        uploadNeeded: true,
        uploadedChunks,
        fileId,
        uploadStrategy: multipartSession ? 'direct-multipart' : 'legacy-chunks',
        multipart: multipartSession,
        projectSpaceId,
      };
    } catch (err) {
      const inputMessage = getUploadInputMessage(err);
      return uploadError(requestId, inputMessage ? 400 : 500, inputMessage || 'Check failed', err, 'Check');
    }
  }

  async initUpload(userId: string, body: UploadBody, requestId?: string) {
    const { filename, hash, size, type } = body;
    const normalizedFilename = filename ?? '';

    try {
      const normalizedHash = requireUploadHash(hash);
      const documentType = ensureSupportedDocument(normalizedFilename);
      const normalizedSize = requireUploadSize(size, documentType.maxBytes);
      const contentType = documentType.canonicalMimeType;
      const requestedProjectSpaceId = readProjectSpaceId(body.project_space_id ?? body.projectSpaceId);
      const projectSpaceId = await resolveProjectSpaceId(userId, requestedProjectSpaceId);
      if (!projectSpaceId) return errorResponse(404, 'Project space not found');

      const reservation = await reserveUploadFile({
        userId,
        projectSpaceId,
        filename: normalizedFilename,
        hash: normalizedHash,
        size: normalizedSize,
        type: contentType,
        declaredMimeType: type,
        documentKind: documentType.documentKind,
        conversionProfile: documentType.conversionProfile,
      });
      const file = reservation.file;

      if (!needsFileBytes(file)) {
        return {
          exists: true,
          uploadNeeded: false,
          uploadId: file.id,
          projectSpaceId,
        };
      }

      return { uploadId: file.id, projectSpaceId };
    } catch (err) {
      const inputMessage = getUploadInputMessage(err);
      const reservationFailure = getUploadReservationFailure(err);
      const publicMessage = reservationFailure?.message || inputMessage || 'Init failed';
      return uploadError(
        requestId,
        getUploadFailureStatus(inputMessage, reservationFailure),
        publicMessage,
        err,
        'Init'
      );
    }
  }

  async initMultipartUpload(userId: string, body: UploadBody, requestId?: string) {
    const { filename, hash, size, type } = body;
    const normalizedFilename = filename ?? '';
    let unclaimedStorageUpload: { objectKey: string; storageUploadId: string } | null = null;

    try {
      const normalizedHash = requireUploadHash(hash);
      const documentType = ensureSupportedDocument(normalizedFilename);
      const normalizedSize = requireUploadSize(size, documentType.maxBytes);
      const contentType = documentType.canonicalMimeType;
      const requestedProjectSpaceId = readProjectSpaceId(body.project_space_id ?? body.projectSpaceId);
      const projectSpaceId = await resolveProjectSpaceId(userId, requestedProjectSpaceId);
      if (!projectSpaceId) return errorResponse(404, 'Project space not found');

      const reservation = await reserveUploadFile({
        userId,
        projectSpaceId,
        filename: normalizedFilename,
        hash: normalizedHash,
        size: normalizedSize,
        type: contentType,
        declaredMimeType: type,
        documentKind: documentType.documentKind,
        conversionProfile: documentType.conversionProfile,
      });
      const file = reservation.file;
      if (!needsFileBytes(file)) {
        return {
          exists: true,
          uploadNeeded: false,
          uploadId: file.id,
          projectSpaceId,
        };
      }

      const activeSession = await findActiveMultipartUploadSession(file.id, userId);
      if (activeSession) {
        return sendExistingMultipartSession(activeSession, file.id, projectSpaceId);
      }
      const partSize = chooseMultipartPartSize(normalizedSize, serverEnv.MULTIPART_UPLOAD_PART_SIZE_BYTES);
      const totalParts = Math.ceil(normalizedSize / partSize);
      if (totalParts > MAX_MULTIPART_UPLOAD_PARTS) {
        return errorResponse(400, `File requires too many parts. Maximum is ${MAX_MULTIPART_UPLOAD_PARTS}`);
      }

      const objectKey = buildDocumentKey(userId, file.id, normalizedFilename);
      const storageUploadId = await createMultipartObjectUpload(objectKey, contentType, {
        sha256: normalizedHash,
        size: String(normalizedSize),
      });
      unclaimedStorageUpload = { objectKey, storageUploadId };
      const expiresAt = new Date(Date.now() + serverEnv.MULTIPART_UPLOAD_SESSION_TTL_MS);
      const creation = await createMultipartUploadSession({
        fileId: file.id,
        userId,
        projectSpaceId,
        objectKey,
        storageUploadId,
        partSize,
        totalParts,
        expiresAt,
      });
      const session = creation.session;

      if (!creation.created) {
        await abortMultipartObjectUpload(objectKey, storageUploadId);
        unclaimedStorageUpload = null;
        const currentSession = await findMultipartUploadSessionForUser(file.id, userId);
        if (!currentSession) {
          return errorResponse(409, 'Multipart upload state changed');
        }
        return sendExistingMultipartSession(currentSession, file.id, projectSpaceId);
      } else {
        unclaimedStorageUpload = null;
      }

      return {
        exists: false,
        uploadNeeded: true,
        uploadStrategy: 'direct-multipart',
        uploadId: file.id,
        partSize: Number(session.part_size),
        totalParts: Number(session.total_parts),
        uploadedPartNumbers: [],
        expiresAt: session.expires_at,
        projectSpaceId,
      };
    } catch (err) {
      const inputMessage = getUploadInputMessage(err);
      const reservationFailure = getUploadReservationFailure(err);
      const stateChanged = isMultipartUploadUnavailableError(err);
      const failureMessage = stateChanged
        ? 'Multipart upload state changed'
        : reservationFailure?.message || inputMessage || 'Multipart init failed';
      if (unclaimedStorageUpload) {
        await abortMultipartObjectUpload(
          unclaimedStorageUpload.objectKey,
          unclaimedStorageUpload.storageUploadId
        ).catch(() => undefined);
      }
      return uploadError(
        requestId,
        stateChanged ? 409 : getUploadFailureStatus(inputMessage, reservationFailure),
        failureMessage,
        err,
        'Multipart init'
      );
    }
  }

  async presignMultipartParts(userId: string, body: UploadBody, requestId?: string) {
    const { uploadId } = body;
    const partNumbers = parseMultipartPartNumbers(body.partNumbers ?? body.part_numbers);

    if (!uploadId || !partNumbers) {
      return errorResponse(400, 'Missing multipart upload parameters');
    }

    try {
      const session = await findMultipartUploadSessionForUser(uploadId, userId);
      if (!session || !['initiated', 'uploading'].includes(session.status)) {
        return errorResponse(404, 'Multipart upload session not found');
      }

      const upload = await findFileForUser(uploadId, userId);
      if (!upload) return errorResponse(404, 'Upload session not found');
      if (partNumbers.some((partNumber) => partNumber > Number(session.total_parts))) {
        return errorResponse(400, 'Part number exceeds reserved upload');
      }

      if (new Date(session.expires_at).getTime() <= Date.now()) {
        const message = 'Multipart upload session expired';
        return errorResponse(410, message);
      }

      const activeSession = await markMultipartUploadSessionUploading(uploadId, userId);
      if (!activeSession) {
        return errorResponse(409, 'Multipart upload state changed');
      }
      const parts = await presignMultipartUploadParts(
        activeSession.object_key,
        activeSession.storage_upload_id,
        partNumbers,
        serverEnv.MULTIPART_UPLOAD_URL_EXPIRES_SECONDS,
        {
          partSize: Number(activeSession.part_size),
          fileSize: Number(upload.file_size),
        }
      );

      return {
        uploadId,
        expiresIn: serverEnv.MULTIPART_UPLOAD_URL_EXPIRES_SECONDS,
        parts,
      };
    } catch (err) {
      return uploadError(requestId, 500, 'Multipart presign failed', err, 'Multipart presign');
    }
  }

  async completeMultipartUpload(userId: string, body: UploadBody, requestId?: string) {
    const { uploadId } = body;

    if (!uploadId) {
      return errorResponse(400, 'Missing uploadId');
    }

    try {
      const upload = await findFileForUser(uploadId, userId);
      if (!upload) return errorResponse(404, 'Upload session not found');

      let session = await findMultipartUploadSessionForUser(uploadId, userId);
      let ownsCompletion = false;
      if (!session) {
        return errorResponse(404, 'Multipart upload session not found');
      }
      if (session.status === 'completed') return multipartCompleteSuccess();
      if (session.status === 'completing') {
        try {
          const object = await inspectCompletedMultipartObject(session, upload);
          if (!object.exists) {
            const reclaimed = await reclaimMultipartUploadCompletion(
              uploadId,
              userId,
              MULTIPART_COMPLETION_RETRYABLE
            );
            if (!reclaimed) {
              return httpResponse({ status: 'completing' }, { statusCode: 202 });
            }
            session = reclaimed;
            ownsCompletion = true;
          } else {
            const result = await finalizeMultipartUploadCompletion(
              uploadId,
              userId,
              session.object_key,
              object.storageBytes
            );
            if (!result.transitioned && result.session?.status !== 'completed') {
              return errorResponse(409, 'Multipart completion state changed');
            }
            if (result.transitioned) fileQueue.trigger();
            return multipartCompleteSuccess();
          }
        } catch (error) {
          const integrityMessage = getCompletedMultipartIntegrityMessage(error);
          if (integrityMessage) {
            await markMultipartUploadCompletionRetryable(
              uploadId,
              userId,
              integrityMessage
            ).catch(() => undefined);
          }
          return uploadError(
            requestId,
            integrityMessage ? 409 : 503,
            integrityMessage || MULTIPART_COMPLETION_RETRYABLE,
            error,
            'Multipart complete reconciliation'
          );
        }
      }
      if (!ownsCompletion) {
        if (!['initiated', 'uploading'].includes(session.status) || upload.status !== 'uploading') {
          return errorResponse(409, 'Multipart upload is not completable');
        }

        if (new Date(session.expires_at).getTime() <= Date.now()) {
          return errorResponse(410, 'Multipart upload session expired');
        }

        const claimed = await claimMultipartUploadCompletion(uploadId, userId);
        if (!claimed) {
          session = await findMultipartUploadSessionForUser(uploadId, userId);
          if (session?.status === 'completed') return multipartCompleteSuccess();
          if (session?.status === 'completing') {
            return httpResponse({ status: 'completing' }, { statusCode: 202 });
          }
          return errorResponse(409, 'Multipart completion state changed');
        }
        session = claimed;
      } else if (upload.status !== 'uploading') {
        return errorResponse(409, 'Multipart completion state changed');
      }

      let storageParts: ReturnType<typeof normalizeStorageParts>;
      let completedStorageBytes: number;
      try {
        storageParts = normalizeStorageParts(
          await listMultipartObjectParts(session.object_key, session.storage_upload_id)
        );
        completedStorageBytes = assertCompletePartSet(
          storageParts,
          Number(session.total_parts),
          upload.file_size,
          Number(session.part_size)
        );
      } catch (error) {
        const completionMessage = getMultipartCompletionMessage(error);
        if (completionMessage) {
          await releaseMultipartUploadCompletion(
            uploadId,
            userId,
            completionMessage
          ).catch(() => undefined);
          return uploadError(requestId, 400, completionMessage, error, 'Multipart complete validation');
        }

        if (isMultipartUploadMissingError(error)) {
          try {
            const object = await inspectCompletedMultipartObject(session, upload);
            if (object.exists) {
              const result = await finalizeMultipartUploadCompletion(
                uploadId,
                userId,
                session.object_key,
                object.storageBytes
              );
              if (result.transitioned) fileQueue.trigger();
              if (result.transitioned || result.session?.status === 'completed') {
                return multipartCompleteSuccess();
              }
            } else {
              const result = await finalizeMultipartUploadFailure(
                uploadId,
                userId,
                MULTIPART_UPLOAD_MISSING
              );
              if (result.transitioned || result.session?.status === 'failed') {
                return errorResponse(409, MULTIPART_UPLOAD_MISSING);
              }
            }
          } catch {
            // The stable retryable response below covers failed reconciliation.
          }
        } else {
          await releaseMultipartUploadCompletion(
            uploadId,
            userId,
            MULTIPART_COMPLETION_RETRYABLE
          ).catch(() => undefined);
        }

        await markMultipartUploadCompletionRetryable(
          uploadId,
          userId,
          MULTIPART_COMPLETION_RETRYABLE
        ).catch(() => undefined);
        return uploadError(
          requestId,
          503,
          MULTIPART_COMPLETION_RETRYABLE,
          error,
          'Multipart complete preparation'
        );
      }

      let completedObjectVerified = false;
      try {
        await completeMultipartObjectUpload(session.object_key, session.storage_upload_id, storageParts);
      } catch (error) {
        try {
          const object = await inspectCompletedMultipartObject(session, upload);
          if (object.exists) {
            completedStorageBytes = object.storageBytes;
            completedObjectVerified = true;
          } else {
            if (isMultipartUploadMissingError(error)) {
              const result = await finalizeMultipartUploadFailure(
                uploadId,
                userId,
                MULTIPART_UPLOAD_MISSING
              );
              if (result.transitioned || result.session?.status === 'failed') {
                return errorResponse(409, MULTIPART_UPLOAD_MISSING);
              }
            }
            if (isStorageClientError(error)) {
              await releaseMultipartUploadCompletion(
                uploadId,
                userId,
                MULTIPART_COMPLETION_REJECTED
              );
              return errorResponse(409, MULTIPART_COMPLETION_REJECTED);
            }
            await markMultipartUploadCompletionRetryable(
              uploadId,
              userId,
              MULTIPART_COMPLETION_RETRYABLE
            ).catch(() => undefined);
            return uploadError(
              requestId,
              503,
              MULTIPART_COMPLETION_RETRYABLE,
              error,
              'Multipart complete storage'
            );
          }
        } catch (reconciliationError) {
          await markMultipartUploadCompletionRetryable(
            uploadId,
            userId,
            MULTIPART_COMPLETION_RETRYABLE
          ).catch(() => undefined);
          return uploadError(
            requestId,
            503,
            MULTIPART_COMPLETION_RETRYABLE,
            reconciliationError,
            'Multipart complete reconciliation'
          );
        }
      }

      if (!completedObjectVerified) {
        try {
          const object = await inspectCompletedMultipartObject(session, upload);
          if (!object.exists) {
            await markMultipartUploadCompletionRetryable(
              uploadId,
              userId,
              MULTIPART_COMPLETION_RETRYABLE
            ).catch(() => undefined);
            return errorResponse(503, MULTIPART_COMPLETION_RETRYABLE);
          }
          completedStorageBytes = object.storageBytes;
        } catch (error) {
          const integrityMessage = getCompletedMultipartIntegrityMessage(error);
          await markMultipartUploadCompletionRetryable(
            uploadId,
            userId,
            integrityMessage || MULTIPART_COMPLETION_RETRYABLE
          ).catch(() => undefined);
          return uploadError(
            requestId,
            integrityMessage ? 409 : 503,
            integrityMessage || MULTIPART_COMPLETION_RETRYABLE,
            error,
            'Multipart complete object verification'
          );
        }
      }

      let result;
      try {
        result = await finalizeMultipartUploadCompletion(
          uploadId,
          userId,
          session.object_key,
          completedStorageBytes
        );
      } catch (error) {
        await markMultipartUploadCompletionRetryable(
          uploadId,
          userId,
          MULTIPART_COMPLETION_RETRYABLE
        ).catch(() => undefined);
        return uploadError(
          requestId,
          503,
          MULTIPART_COMPLETION_RETRYABLE,
          error,
          'Multipart complete database finalization'
        );
      }

      if (!result.transitioned && result.session?.status !== 'completed') {
        return errorResponse(409, 'Multipart completion state changed');
      }
      if (result.transitioned) fileQueue.trigger();

      return multipartCompleteSuccess();
    } catch (err) {
      await markMultipartUploadCompletionRetryable(
        uploadId,
        userId,
        MULTIPART_COMPLETION_RETRYABLE
      ).catch(() => undefined);
      return uploadError(
        requestId,
        503,
        MULTIPART_COMPLETION_RETRYABLE,
        err,
        'Multipart complete'
      );
    }
  }

  async abortMultipartUpload(userId: string, body: UploadBody, requestId?: string) {
    const { uploadId } = body;

    if (!uploadId) {
      return errorResponse(400, 'Missing uploadId');
    }

    try {
      let session = await findMultipartUploadSessionForUser(uploadId, userId);
      if (!session) return errorResponse(404, 'Multipart upload session not found');
      if (session.status === 'completed' || session.status === 'completing') {
        return errorResponse(409, 'Multipart upload completion already won');
      }
      if (session.status === 'cancelled') return { success: true };
      if (!['initiated', 'uploading', 'cancelling'].includes(session.status)) {
        return errorResponse(409, 'Multipart upload is not cancellable');
      }

      if (session.status !== 'cancelling') {
        const claimed = await claimMultipartUploadAbort(uploadId, userId);
        if (!claimed) {
          session = await findMultipartUploadSessionForUser(uploadId, userId);
          if (session?.status === 'cancelled') return { success: true };
          if (session?.status === 'completed' || session?.status === 'completing') {
            return errorResponse(409, 'Multipart upload completion already won');
          }
          if (session?.status !== 'cancelling') {
            return errorResponse(409, 'Multipart abort state changed');
          }
        } else {
          session = claimed;
        }
      }

      const message = 'Multipart upload cancelled';
      try {
        await abortMultipartObjectUpload(session.object_key, session.storage_upload_id);
      } catch (error) {
        if (isMultipartUploadMissingError(error)) {
          try {
            const upload = await findFileForUser(uploadId, userId);
            if (!upload) return errorResponse(404, 'Upload session not found');
            const object = await inspectCompletedMultipartObject(session, upload);
            if (object.exists) {
              const result = await finalizeMultipartUploadCompletion(
                uploadId,
                userId,
                session.object_key,
                object.storageBytes
              );
              if (result.transitioned || result.session?.status === 'completed') {
                if (result.transitioned) fileQueue.trigger();
                return errorResponse(409, 'Multipart upload was already completed');
              }
              throw new Error('Multipart completion reconciliation did not transition', {
                cause: error,
              });
            }

            const result = await finalizeMultipartUploadAbort(
              uploadId,
              userId,
              message
            );
            if (result.transitioned || result.session?.status === 'cancelled') {
              return { success: true };
            }
            if (result.session?.status === 'completed') {
              return errorResponse(409, 'Multipart upload was already completed');
            }
          } catch (reconciliationError) {
            await markMultipartUploadAbortRetryable(
              uploadId,
              userId,
              MULTIPART_ABORT_RETRYABLE
            ).catch(() => undefined);
            return uploadError(
              requestId,
              503,
              MULTIPART_ABORT_RETRYABLE,
              reconciliationError,
              'Multipart abort reconciliation'
            );
          }
        } else {
          try {
            const upload = await findFileForUser(uploadId, userId);
            if (upload) {
              const object = await inspectCompletedMultipartObject(session, upload);
              if (object.exists) {
                const result = await finalizeMultipartUploadCompletion(
                  uploadId,
                  userId,
                  session.object_key,
                  object.storageBytes
                );
                if (result.transitioned || result.session?.status === 'completed') {
                  if (result.transitioned) fileQueue.trigger();
                  return errorResponse(409, 'Multipart upload was already completed');
                }
                throw new Error('Multipart completion reconciliation did not transition', {
                  cause: error,
                });
              }
            }
          } catch {
            // Unknown storage outcomes remain retryable below.
          }
        }

        await markMultipartUploadAbortRetryable(
          uploadId,
          userId,
          MULTIPART_ABORT_RETRYABLE
        ).catch(() => undefined);
        return uploadError(
          requestId,
          503,
          MULTIPART_ABORT_RETRYABLE,
          error,
          'Multipart abort storage'
        );
      }

      const result = await finalizeMultipartUploadAbort(uploadId, userId, message);
      if (!result.transitioned && result.session?.status !== 'cancelled') {
        if (result.session?.status === 'completed') {
          return errorResponse(409, 'Multipart upload was already completed');
        }
        return errorResponse(409, 'Multipart abort state changed');
      }

      return { success: true };
    } catch (err) {
      await markMultipartUploadAbortRetryable(
        uploadId,
        userId,
        MULTIPART_ABORT_RETRYABLE
      ).catch(() => undefined);
      return uploadError(requestId, 503, MULTIPART_ABORT_RETRYABLE, err, 'Multipart abort');
    }
  }

  async uploadChunk(userId: string, body: UploadBody, file: BufferedUpload | undefined, requestId?: string) {
    const { uploadId, chunkIndex } = body;
    const parsedChunkIndex = parseUploadChunkIndex(chunkIndex);

    if (!uploadId || parsedChunkIndex === null || !file) {
      return errorResponse(400, 'Missing parameters');
    }

    try {
      const upload = await findFileForUser(uploadId, userId);
      if (!upload || upload.status !== 'uploading') {
        return errorResponse(404, 'Upload session not found');
      }

      const declaredSize = Number(upload.file_size);
      const chunkStart = parsedChunkIndex * DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES;
      const chunkEnd = chunkStart + file.buffer.byteLength;
      if (!Number.isSafeInteger(declaredSize) || chunkStart >= declaredSize || chunkEnd > declaredSize) {
        return errorResponse(413, 'Chunk exceeds the reserved document size');
      }

      // uploadId passed the strict UUID mutation schema and the owner-scoped database lookup above.
      const chunkDir = path.join(UPLOAD_DIR, uploadId); // nosemgrep
      await fs.ensureDir(chunkDir);

      // parsedChunkIndex is a non-negative bounded integer from parseUploadChunkIndex.
      const chunkPath = path.join(chunkDir, parsedChunkIndex.toString()); // nosemgrep
      await fs.writeFile(chunkPath, file.buffer);

      return { success: true };
    } catch (err) {
      return uploadError(requestId, 500, 'Chunk upload failed', err, 'Chunk upload');
    }
  }

  async mergeChunks(userId: string, body: UploadBody, requestId?: string) {
    const { uploadId, filename, totalChunks } = body;
    const expectedChunks = parseUploadTotalChunks(totalChunks);
    let chunkDirToCleanup: string | null = null;
    let mergedFilePathToCleanup: string | null = null;
    let completedObjectKey: string | null = null;
    let completedStorageBytes: number | null = null;

    if (!uploadId || !filename || expectedChunks === null) {
      return errorResponse(400, 'Missing parameters');
    }

    try {
      const contentType = ensureSupportedDocumentFilename(filename);

      const upload = await findFileForUser(uploadId, userId);
      if (!upload || upload.status !== 'uploading') {
        return errorResponse(404, 'Upload session not found');
      }

      // uploadId passed the strict UUID mutation schema and the owner-scoped database lookup above.
      const chunkDir = path.join(UPLOAD_DIR, uploadId); // nosemgrep
      chunkDirToCleanup = chunkDir;
      if (!await fs.pathExists(chunkDir)) {
        return errorResponse(400, 'Upload session not found');
      }

      const files = await fs.readdir(chunkDir);
      if (files.length !== expectedChunks) {
        return errorResponse(400, `Missing chunks. Expected ${expectedChunks}, found ${files.length}`);
      }

      files.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

      for (let i = 0; i < expectedChunks; i++) {
        if (!files.includes(i.toString())) {
          return errorResponse(400, `Missing chunk ${i}`);
        }
      }

      // uploadId is a validated UUID, so the generated basename cannot escape UPLOAD_DIR.
      const mergedFilePath = path.join(UPLOAD_DIR, `${uploadId}_merged`); // nosemgrep
      mergedFilePathToCleanup = mergedFilePath;
      const writeStream = fs.createWriteStream(mergedFilePath);

      for (let i = 0; i < expectedChunks; i++) {
        // i is generated by this bounded loop and cannot contain path separators.
        const chunkPath = path.join(chunkDir, i.toString()); // nosemgrep
        await pipeline(fs.createReadStream(chunkPath), writeStream, { end: false });
      }

      writeStream.end();

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const digest = await verifyMergedUploadFile(mergedFilePath, {
        expectedHash: upload.file_hash,
        expectedSize: upload.file_size,
      });
      completedStorageBytes = digest.size;

      const objectKey = buildDocumentKey(userId, uploadId, filename);
      await uploadFilePath(objectKey, mergedFilePath, upload.file_type || contentType);
      completedObjectKey = objectKey;

      const updatedFile = await updateFile(uploadId, {
        status: 'pending',
        object_key: objectKey,
        progress: 0,
        error_message: null,
        reserved_bytes: 0,
        storage_bytes: digest.size,
      });

      await fs.remove(chunkDir);
      await fs.remove(mergedFilePath);

      if (!updatedFile) {
        artifactCleanupQueue.trigger();
        const message = 'Upload was deleted while finalizing';
        return uploadError(requestId, 409, message, new Error(message), 'Merge');
      }

      fileQueue.trigger();

      return { success: true, message: 'File merged and queued for processing' };
    } catch (err) {
      const inputMessage = getUploadInputMessage(err);
      const integrityMessage = getMergeIntegrityMessage(err);
      const failureMessage = inputMessage || integrityMessage || 'Merge failed';
      const isIntegrityFailure = Boolean(integrityMessage || inputMessage === UPLOAD_HASH_ERROR);
      if (completedObjectKey && completedStorageBytes !== null) {
        const updatedFile = await updateFile(uploadId, {
          status: 'failed',
          object_key: completedObjectKey,
          progress: 0,
          error_message: failureMessage,
          reserved_bytes: 0,
          storage_bytes: completedStorageBytes,
        }).catch(() => undefined);
        if (!updatedFile) artifactCleanupQueue.trigger();
      } else if (isIntegrityFailure) {
        await Promise.all([
          chunkDirToCleanup ? fs.remove(chunkDirToCleanup).catch(() => undefined) : Promise.resolve(),
          mergedFilePathToCleanup ? fs.remove(mergedFilePathToCleanup).catch(() => undefined) : Promise.resolve(),
        ]);
        await updateFile(uploadId, {
          status: 'failed',
          progress: 0,
          error_message: failureMessage,
          reserved_bytes: 0,
          storage_bytes: 0,
        }).catch(() => undefined);
      }
      const isPublicFailure = Boolean(inputMessage || integrityMessage);
      return uploadError(requestId, isPublicFailure ? 400 : 500, failureMessage, err, 'Merge');
    }
  }

  async listFiles(userId: string, query: UploadQuery, requestId?: string) {
    try {
      const requestedProjectSpaceId = readProjectSpaceId(query.projectSpaceId || query.project_space_id);
      if (requestedProjectSpaceId) {
        const space = await findProjectSpaceForUser(requestedProjectSpaceId, userId);
        if (!space) return errorResponse(404, 'Project space not found');
      }

      return await listFilesForUser(userId, requestedProjectSpaceId);
    } catch (err) {
      return uploadError(requestId, 500, 'Failed to fetch files', err, 'File listing');
    }
  }

  async getFileContent(
    userId: string,
    id: string,
    requestId?: string,
    dependencyOverrides: Partial<DocumentReadDependencies> = {},
  ) {
    const dependencies = documentReadDependencies(dependencyOverrides);
    let content;
    try {
      content = await dependencies.findActiveContent(id, userId);
    } catch (err) {
      console.warn('[Upload] File content lookup failed:', toSafeError(err, requestId));
      throw requestError(503, 'File content is unavailable');
    }
    if (!content) {
      throw requestError(404, 'File content not found');
    }

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
      if (isObjectNotFoundError(error)) {
        throw requestError(404, 'File content not found');
      }
      console.warn('[Upload] File content lookup failed:', toSafeError(error, requestId));
      throw requestError(503, 'File content is unavailable');
    }
  }

  async getFileOriginal(
    userId: string,
    id: string,
    requestId?: string,
    dependencyOverrides: Partial<DocumentReadDependencies> = {},
  ) {
    const dependencies = documentReadDependencies(dependencyOverrides);
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
      if (isObjectNotFoundError(error)) {
        throw requestError(404, 'File original not found');
      }
      console.warn('[Upload] File original lookup failed:', toSafeError(error, requestId));
      throw requestError(503, 'File original is unavailable');
    }
  }

  async retryFileProcessing(userId: string, id: string, requestId?: string) {
    try {
      const file = await retryFailedFileForUser(id, userId);
      if (!file) return errorResponse(404, 'Failed file not found');

      fileQueue.trigger();
      return file;
    } catch (err) {
      return uploadError(requestId, 500, 'Retry failed', err, 'File processing retry');
    }
  }

  async deleteFile(userId: string, id: string, requestId?: string) {
    try {
      const cleanup = await enqueueFileCleanup(id, userId);
      if (!cleanup) return errorResponse(404, 'File not found');
      artifactCleanupQueue.trigger();
      return httpResponse(
        { status: 'deleting', cleanup_job_id: cleanup.id },
        { statusCode: 202 },
      );
    } catch (err) {
      return uploadError(requestId, 500, 'Internal server error', err, 'File deletion');
    }
  }

  async uploadAvatar(userId: string, file: BufferedUpload | undefined, requestId?: string) {
    if (!file) return errorResponse(400, 'Avatar file is required');
    if (!file.mimetype.startsWith('image/')) {
      return errorResponse(400, 'Only image files are supported');
    }

    const objectKey = buildAvatarKey(userId, file.originalname);
    try {
      await uploadBuffer(objectKey, file.buffer, file.mimetype);

      const avatarUrl = `/api/upload/avatar/${userId}`;
      let replacement;
      try {
        replacement = await replaceUserAvatar(userId, {
          avatarUrl,
          objectKey,
        });
        if (!replacement) throw new Error('Avatar user is unavailable');
      } catch (updateError) {
        try {
          await deleteObject(objectKey);
        } catch (deleteError) {
          try {
            await enqueueAvatarCleanup(objectKey);
            artifactCleanupQueue.trigger();
          } catch (queueError) {
            console.error(
              '[Upload] Failed to queue new avatar compensation:',
              toSafeError(queueError, requestId)
            );
          }
          console.warn(
            '[Upload] Failed to delete uncommitted avatar object:',
            toSafeError(deleteError, requestId)
          );
        }
        throw updateError;
      }

      if (replacement.previousObjectKey && replacement.cleanupJob) {
        try {
          await deleteObject(replacement.previousObjectKey);
        } catch (deleteError) {
          console.warn(
            '[Upload] Failed to delete old avatar object:',
            toSafeError(deleteError, requestId)
          );
        }
        artifactCleanupQueue.trigger();
      }

      return { url: avatarUrl, user: replacement.user };
    } catch (err) {
      return uploadError(requestId, 500, 'Avatar upload failed', err, 'Avatar upload');
    }
  }

  async getAvatar(currentUserId: string, userId: string, requestId?: string) {
    if (userId !== currentUserId) {
      throw requestError(403, 'Forbidden');
    }

    try {
      const user = await findUserById(userId);
      if (!user?.avatar_object_key) {
        throw requestError(404, 'Avatar not found');
      }

      const { stream, contentType } = await getObjectStream(user.avatar_object_key);
      const headers: Record<string, string> = {
        'Cache-Control': 'private, max-age=300',
      };
      if (contentType) headers['Content-Type'] = contentType;
      return httpResponse(new StreamableFile(stream), { headers });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      console.warn('[Upload] Avatar lookup failed:', toSafeError(err, requestId));
      throw new HttpException(
        { error: 'Avatar not found', details: 'Avatar not found' },
        404,
      );
    }
  }
}

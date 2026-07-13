import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs-extra';
import { pipeline } from 'stream/promises';
import { toSafeError } from '../lib/safeError';
import {
  abortMultipartObjectUpload,
  buildAvatarKey,
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
} from '../lib/storage';
import {
  type FileRow,
  findClaimedFileByUserAndHash,
  findFileForUser,
  listFilesForUser,
  reserveUploadFile,
  retryFailedFileForUser,
  updateFile,
} from '../repositories/files';
import { enqueueAvatarCleanup, enqueueFileCleanup } from '../repositories/cleanupJobs';
import {
  ensureDefaultProjectSpaceForUser,
  findProjectSpaceForUser,
} from '../repositories/projectSpaces';
import { findUserById, replaceUserAvatar, updateUser } from '../repositories/users';
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
} from '../repositories/uploadMultipart';
import { fileQueue } from '../services/fileQueue';
import { artifactCleanupQueue } from '../services/cleanupQueue';
import { verifyMergedUploadFile } from '../lib/uploadIntegrity';
import {
  MAX_MULTIPART_UPLOAD_PARTS,
  SUPPORTED_DOCUMENT_ERROR,
  UPLOAD_HASH_ERROR,
  UPLOAD_SIZE_ERROR,
  UPLOAD_TOO_LARGE_ERROR,
  chooseMultipartPartSize,
  getSupportedDocumentContentType,
  parseMultipartPartNumbers,
  parseUploadFileHash,
  parseUploadFileSize,
  parseUploadChunkIndex,
  parseUploadTotalChunks,
} from '../lib/uploadInput';
import { serverEnv } from '../lib/env';
import { DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES } from '../lib/uploadMiddleware';

const UPLOAD_DIR = path.join(__dirname, '../../uploads/temp');
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

const sendUploadError = (
  res: Response,
  status: number,
  publicMessage: string,
  error: unknown,
  operation: string
) => {
  if (status >= 500) {
    console.error('[Upload] operation failed:', {
      operation,
      error: toSafeError(error, res.locals?.requestId),
    });
  }
  return res.status(status).json({ error: publicMessage, details: publicMessage });
};

const ensureSupportedDocumentFilename = (filename?: string) => {
  const contentType = getSupportedDocumentContentType(filename);
  if (!contentType) {
    throw new Error(SUPPORTED_DOCUMENT_ERROR);
  }
  return contentType;
};

const requireUploadHash = (value: unknown) => {
  const hash = parseUploadFileHash(value);
  if (!hash) throw new Error(UPLOAD_HASH_ERROR);
  return hash;
};

const requireUploadSize = (value: unknown) => {
  const size = parseUploadFileSize(value, serverEnv.MAX_DOCUMENT_BYTES);
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
  res: Response,
  session: MultipartUploadSessionRow,
  fileId: string,
  projectSpaceId: string
) => {
  if (session.status === 'completed') {
    return res.json({
      exists: true,
      uploadNeeded: false,
      uploadId: fileId,
      projectSpaceId,
    });
  }
  if (session.status === 'completing') {
    return res.status(409).json({ error: 'Multipart upload completion is in progress' });
  }
  if (session.status === 'cancelling') {
    return res.status(409).json({ error: 'Multipart upload cancellation is pending' });
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ error: 'Multipart upload cleanup is pending' });
  }

  const uploadedParts = await listMultipartObjectParts(
    session.object_key,
    session.storage_upload_id
  ).catch(() => []);
  return res.json({
    exists: false,
    uploadNeeded: true,
    uploadStrategy: 'direct-multipart',
    uploadId: fileId,
    partSize: Number(session.part_size),
    totalParts: Number(session.total_parts),
    uploadedPartNumbers: normalizeStorageParts(uploadedParts).map((part) => part.partNumber),
    expiresAt: session.expires_at,
    projectSpaceId,
  });
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

const assertCompletedMultipartObject = (
  object: { size: number; metadata: Record<string, string | undefined> },
  upload: Pick<FileRow, 'file_hash' | 'file_size'>
) => {
  const expectedSize = Number(upload.file_size);
  const expectedHash = upload.file_hash.toLowerCase();
  const metadataHash = object.metadata.sha256?.toLowerCase();
  const metadataSize = Number(object.metadata.size);

  if (!Number.isSafeInteger(expectedSize) || object.size !== expectedSize) {
    throw new Error(`Completed multipart object size mismatch: expected ${expectedSize}, got ${object.size}`);
  }
  if (metadataHash !== expectedHash) {
    throw new Error('Completed multipart object hash metadata mismatch');
  }
  if (!Number.isSafeInteger(metadataSize) || metadataSize !== expectedSize) {
    throw new Error('Completed multipart object size metadata mismatch');
  }

  return object.size;
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

const sendMultipartCompleteSuccess = (res: Response) => (
  res.json({ success: true, message: 'File uploaded and queued for processing' })
);

const MULTIPART_COMPLETION_RETRYABLE = 'Multipart completion is pending reconciliation';
const MULTIPART_ABORT_RETRYABLE = 'Multipart abort is pending reconciliation';
const MULTIPART_UPLOAD_MISSING = 'Multipart upload no longer exists';
const MULTIPART_COMPLETION_REJECTED = 'Multipart completion was rejected by storage';

export const checkFile = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { hash, filename } = req.body;

  try {
    const normalizedHash = requireUploadHash(hash);
    ensureSupportedDocumentFilename(filename);
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.status(404).json({ error: 'Project space not found' });

    const claimedFile = await findClaimedFileByUserAndHash(req.user.id, normalizedHash, projectSpaceId);

    if (claimedFile && !needsFileBytes(claimedFile)) {
      return res.json({
        exists: true,
        uploadNeeded: false,
        fileId: claimedFile.id,
        projectSpaceId,
      });
    }

    const fileId = claimedFile?.status === 'uploading' ? claimedFile.id : undefined;
    let uploadedChunks: number[] = [];
    let multipartSession = null;

    if (fileId) {
      const activeSession = await findActiveMultipartUploadSession(fileId, req.user.id);
      if (activeSession) {
        if (activeSession.status === 'completing') {
          return res.status(409).json({ error: 'Multipart upload completion is in progress' });
        }
        if (activeSession.status === 'cancelling') {
          return res.status(409).json({ error: 'Multipart upload cancellation is pending' });
        }
        if (new Date(activeSession.expires_at).getTime() <= Date.now()) {
          return res.status(410).json({ error: 'Multipart upload cleanup is pending' });
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

    res.json({
      exists: false,
      uploadNeeded: true,
      uploadedChunks,
      fileId,
      uploadStrategy: multipartSession ? 'direct-multipart' : 'legacy-chunks',
      multipart: multipartSession,
      projectSpaceId,
    });
  } catch (err) {
    const inputMessage = getUploadInputMessage(err);
    return sendUploadError(res, inputMessage ? 400 : 500, inputMessage || 'Check failed', err, 'Check');
  }
};

export const initUpload = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { filename, hash, size, type } = req.body;

  try {
    const normalizedHash = requireUploadHash(hash);
    const normalizedSize = requireUploadSize(size);
    const contentType = ensureSupportedDocumentFilename(filename);
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.status(404).json({ error: 'Project space not found' });

    const reservation = await reserveUploadFile({
      userId: req.user.id,
      projectSpaceId,
      filename,
      hash: normalizedHash,
      size: normalizedSize,
      type: getSupportedDocumentContentType(filename) || type || contentType,
    });
    const file = reservation.file;

    if (!needsFileBytes(file)) {
      return res.json({
        exists: true,
        uploadNeeded: false,
        uploadId: file.id,
        projectSpaceId,
      });
    }

    res.json({ uploadId: file.id, projectSpaceId });
  } catch (err) {
    const inputMessage = getUploadInputMessage(err);
    const reservationFailure = getUploadReservationFailure(err);
    const publicMessage = reservationFailure?.message || inputMessage || 'Init failed';
    return sendUploadError(
      res,
      getUploadFailureStatus(inputMessage, reservationFailure),
      publicMessage,
      err,
      'Init'
    );
  }
};

export const initMultipartUpload = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { filename, hash, size, type } = req.body;
  let unclaimedStorageUpload: { objectKey: string; storageUploadId: string } | null = null;

  try {
    const normalizedHash = requireUploadHash(hash);
    const normalizedSize = requireUploadSize(size);
    const contentType = ensureSupportedDocumentFilename(filename);
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.status(404).json({ error: 'Project space not found' });

    const reservation = await reserveUploadFile({
      userId: req.user.id,
      projectSpaceId,
      filename,
      hash: normalizedHash,
      size: normalizedSize,
      type: getSupportedDocumentContentType(filename) || type || contentType,
    });
    const file = reservation.file;
    if (!needsFileBytes(file)) {
      return res.json({
        exists: true,
        uploadNeeded: false,
        uploadId: file.id,
        projectSpaceId,
      });
    }

    const activeSession = await findActiveMultipartUploadSession(file.id, req.user.id);
    if (activeSession) {
      return sendExistingMultipartSession(res, activeSession, file.id, projectSpaceId);
    }
    const partSize = chooseMultipartPartSize(normalizedSize, serverEnv.MULTIPART_UPLOAD_PART_SIZE_BYTES);
    const totalParts = Math.ceil(normalizedSize / partSize);
    if (totalParts > MAX_MULTIPART_UPLOAD_PARTS) {
      return res.status(400).json({ error: `File requires too many parts. Maximum is ${MAX_MULTIPART_UPLOAD_PARTS}` });
    }

    const objectKey = buildDocumentKey(req.user.id, file.id, filename);
    const storageUploadId = await createMultipartObjectUpload(objectKey, contentType, {
      sha256: normalizedHash,
      size: String(normalizedSize),
    });
    unclaimedStorageUpload = { objectKey, storageUploadId };
    const expiresAt = new Date(Date.now() + serverEnv.MULTIPART_UPLOAD_SESSION_TTL_MS);
    const creation = await createMultipartUploadSession({
      fileId: file.id,
      userId: req.user.id,
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
      const currentSession = await findMultipartUploadSessionForUser(file.id, req.user.id);
      if (!currentSession) {
        return res.status(409).json({ error: 'Multipart upload state changed' });
      }
      return sendExistingMultipartSession(res, currentSession, file.id, projectSpaceId);
    } else {
      unclaimedStorageUpload = null;
    }

    res.json({
      exists: false,
      uploadNeeded: true,
      uploadStrategy: 'direct-multipart',
      uploadId: file.id,
      partSize: Number(session.part_size),
      totalParts: Number(session.total_parts),
      uploadedPartNumbers: [],
      expiresAt: session.expires_at,
      projectSpaceId,
    });
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
    return sendUploadError(
      res,
      stateChanged ? 409 : getUploadFailureStatus(inputMessage, reservationFailure),
      failureMessage,
      err,
      'Multipart init'
    );
  }
};

export const presignMultipartParts = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { uploadId } = req.body;
  const partNumbers = parseMultipartPartNumbers(req.body.partNumbers ?? req.body.part_numbers);

  if (!uploadId || !partNumbers) {
    return res.status(400).json({ error: 'Missing multipart upload parameters' });
  }

  try {
    const session = await findMultipartUploadSessionForUser(uploadId, req.user.id);
    if (!session || !['initiated', 'uploading'].includes(session.status)) {
      return res.status(404).json({ error: 'Multipart upload session not found' });
    }

    const upload = await findFileForUser(uploadId, req.user.id);
    if (!upload) return res.status(404).json({ error: 'Upload session not found' });
    if (partNumbers.some((partNumber) => partNumber > Number(session.total_parts))) {
      return res.status(400).json({ error: 'Part number exceeds reserved upload' });
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      const message = 'Multipart upload session expired';
      return res.status(410).json({ error: message });
    }

    const activeSession = await markMultipartUploadSessionUploading(uploadId, req.user.id);
    if (!activeSession) {
      return res.status(409).json({ error: 'Multipart upload state changed' });
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

    res.json({
      uploadId,
      expiresIn: serverEnv.MULTIPART_UPLOAD_URL_EXPIRES_SECONDS,
      parts,
    });
  } catch (err) {
    return sendUploadError(res, 500, 'Multipart presign failed', err, 'Multipart presign');
  }
};

export const completeMultipartUpload = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { uploadId } = req.body;

  if (!uploadId) {
    return res.status(400).json({ error: 'Missing uploadId' });
  }

  try {
    const upload = await findFileForUser(uploadId, req.user.id);
    if (!upload) return res.status(404).json({ error: 'Upload session not found' });

    let session = await findMultipartUploadSessionForUser(uploadId, req.user.id);
    let ownsCompletion = false;
    if (!session) {
      return res.status(404).json({ error: 'Multipart upload session not found' });
    }
    if (session.status === 'completed') return sendMultipartCompleteSuccess(res);
    if (session.status === 'completing') {
      try {
        const object = await inspectCompletedMultipartObject(session, upload);
        if (!object.exists) {
          const reclaimed = await reclaimMultipartUploadCompletion(
            uploadId,
            req.user.id,
            MULTIPART_COMPLETION_RETRYABLE
          );
          if (!reclaimed) {
            return res.status(202).json({ status: 'completing' });
          }
          session = reclaimed;
          ownsCompletion = true;
        } else {
          const result = await finalizeMultipartUploadCompletion(
            uploadId,
            req.user.id,
            session.object_key,
            object.storageBytes
          );
          if (!result.transitioned && result.session?.status !== 'completed') {
            return res.status(409).json({ error: 'Multipart completion state changed' });
          }
          if (result.transitioned) fileQueue.trigger();
          return sendMultipartCompleteSuccess(res);
        }
      } catch (error) {
        const integrityMessage = getCompletedMultipartIntegrityMessage(error);
        if (integrityMessage) {
          await markMultipartUploadCompletionRetryable(
            uploadId,
            req.user.id,
            integrityMessage
          ).catch(() => undefined);
        }
        return sendUploadError(
          res,
          integrityMessage ? 409 : 503,
          integrityMessage || MULTIPART_COMPLETION_RETRYABLE,
          error,
          'Multipart complete reconciliation'
        );
      }
    }
    if (!ownsCompletion) {
      if (!['initiated', 'uploading'].includes(session.status) || upload.status !== 'uploading') {
        return res.status(409).json({ error: 'Multipart upload is not completable' });
      }

      if (new Date(session.expires_at).getTime() <= Date.now()) {
        return res.status(410).json({ error: 'Multipart upload session expired' });
      }

      const claimed = await claimMultipartUploadCompletion(uploadId, req.user.id);
      if (!claimed) {
        session = await findMultipartUploadSessionForUser(uploadId, req.user.id);
        if (session?.status === 'completed') return sendMultipartCompleteSuccess(res);
        if (session?.status === 'completing') {
          return res.status(202).json({ status: 'completing' });
        }
        return res.status(409).json({ error: 'Multipart completion state changed' });
      }
      session = claimed;
    } else if (upload.status !== 'uploading') {
      return res.status(409).json({ error: 'Multipart completion state changed' });
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
          req.user.id,
          completionMessage
        ).catch(() => undefined);
        return sendUploadError(res, 400, completionMessage, error, 'Multipart complete validation');
      }

      if (isMultipartUploadMissingError(error)) {
        try {
          const object = await inspectCompletedMultipartObject(session, upload);
          if (object.exists) {
            const result = await finalizeMultipartUploadCompletion(
              uploadId,
              req.user.id,
              session.object_key,
              object.storageBytes
            );
            if (result.transitioned) fileQueue.trigger();
            if (result.transitioned || result.session?.status === 'completed') {
              return sendMultipartCompleteSuccess(res);
            }
          } else {
            const result = await finalizeMultipartUploadFailure(
              uploadId,
              req.user.id,
              MULTIPART_UPLOAD_MISSING
            );
            if (result.transitioned || result.session?.status === 'failed') {
              return res.status(409).json({ error: MULTIPART_UPLOAD_MISSING });
            }
          }
        } catch {
          // The stable retryable response below covers failed reconciliation.
        }
      } else {
        await releaseMultipartUploadCompletion(
          uploadId,
          req.user.id,
          MULTIPART_COMPLETION_RETRYABLE
        ).catch(() => undefined);
      }

      await markMultipartUploadCompletionRetryable(
        uploadId,
        req.user.id,
        MULTIPART_COMPLETION_RETRYABLE
      ).catch(() => undefined);
      return sendUploadError(
        res,
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
              req.user.id,
              MULTIPART_UPLOAD_MISSING
            );
            if (result.transitioned || result.session?.status === 'failed') {
              return res.status(409).json({ error: MULTIPART_UPLOAD_MISSING });
            }
          }
          if (isStorageClientError(error)) {
            await releaseMultipartUploadCompletion(
              uploadId,
              req.user.id,
              MULTIPART_COMPLETION_REJECTED
            );
            return res.status(409).json({ error: MULTIPART_COMPLETION_REJECTED });
          }
          await markMultipartUploadCompletionRetryable(
            uploadId,
            req.user.id,
            MULTIPART_COMPLETION_RETRYABLE
          ).catch(() => undefined);
          return sendUploadError(
            res,
            503,
            MULTIPART_COMPLETION_RETRYABLE,
            error,
            'Multipart complete storage'
          );
        }
      } catch (reconciliationError) {
        await markMultipartUploadCompletionRetryable(
          uploadId,
          req.user.id,
          MULTIPART_COMPLETION_RETRYABLE
        ).catch(() => undefined);
        return sendUploadError(
          res,
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
            req.user.id,
            MULTIPART_COMPLETION_RETRYABLE
          ).catch(() => undefined);
          return res.status(503).json({ error: MULTIPART_COMPLETION_RETRYABLE });
        }
        completedStorageBytes = object.storageBytes;
      } catch (error) {
        const integrityMessage = getCompletedMultipartIntegrityMessage(error);
        await markMultipartUploadCompletionRetryable(
          uploadId,
          req.user.id,
          integrityMessage || MULTIPART_COMPLETION_RETRYABLE
        ).catch(() => undefined);
        return sendUploadError(
          res,
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
        req.user.id,
        session.object_key,
        completedStorageBytes
      );
    } catch (error) {
      await markMultipartUploadCompletionRetryable(
        uploadId,
        req.user.id,
        MULTIPART_COMPLETION_RETRYABLE
      ).catch(() => undefined);
      return sendUploadError(
        res,
        503,
        MULTIPART_COMPLETION_RETRYABLE,
        error,
        'Multipart complete database finalization'
      );
    }

    if (!result.transitioned && result.session?.status !== 'completed') {
      return res.status(409).json({ error: 'Multipart completion state changed' });
    }
    if (result.transitioned) fileQueue.trigger();

    return sendMultipartCompleteSuccess(res);
  } catch (err) {
    await markMultipartUploadCompletionRetryable(
      uploadId,
      req.user.id,
      MULTIPART_COMPLETION_RETRYABLE
    ).catch(() => undefined);
    return sendUploadError(
      res,
      503,
      MULTIPART_COMPLETION_RETRYABLE,
      err,
      'Multipart complete'
    );
  }
};

export const abortMultipartUpload = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { uploadId } = req.body;

  if (!uploadId) {
    return res.status(400).json({ error: 'Missing uploadId' });
  }

  try {
    let session = await findMultipartUploadSessionForUser(uploadId, req.user.id);
    if (!session) return res.status(404).json({ error: 'Multipart upload session not found' });
    if (session.status === 'completed' || session.status === 'completing') {
      return res.status(409).json({ error: 'Multipart upload completion already won' });
    }
    if (session.status === 'cancelled') return res.json({ success: true });
    if (!['initiated', 'uploading', 'cancelling'].includes(session.status)) {
      return res.status(409).json({ error: 'Multipart upload is not cancellable' });
    }

    if (session.status !== 'cancelling') {
      const claimed = await claimMultipartUploadAbort(uploadId, req.user.id);
      if (!claimed) {
        session = await findMultipartUploadSessionForUser(uploadId, req.user.id);
        if (session?.status === 'cancelled') return res.json({ success: true });
        if (session?.status === 'completed' || session?.status === 'completing') {
          return res.status(409).json({ error: 'Multipart upload completion already won' });
        }
        if (session?.status !== 'cancelling') {
          return res.status(409).json({ error: 'Multipart abort state changed' });
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
          const upload = await findFileForUser(uploadId, req.user.id);
          if (!upload) return res.status(404).json({ error: 'Upload session not found' });
          const object = await inspectCompletedMultipartObject(session, upload);
          if (object.exists) {
            const result = await finalizeMultipartUploadCompletion(
              uploadId,
              req.user.id,
              session.object_key,
              object.storageBytes
            );
            if (result.transitioned || result.session?.status === 'completed') {
              if (result.transitioned) fileQueue.trigger();
              return res.status(409).json({ error: 'Multipart upload was already completed' });
            }
            throw new Error('Multipart completion reconciliation did not transition');
          }

          const result = await finalizeMultipartUploadAbort(
            uploadId,
            req.user.id,
            message
          );
          if (result.transitioned || result.session?.status === 'cancelled') {
            return res.json({ success: true });
          }
          if (result.session?.status === 'completed') {
            return res.status(409).json({ error: 'Multipart upload was already completed' });
          }
        } catch (reconciliationError) {
          await markMultipartUploadAbortRetryable(
            uploadId,
            req.user.id,
            MULTIPART_ABORT_RETRYABLE
          ).catch(() => undefined);
          return sendUploadError(
            res,
            503,
            MULTIPART_ABORT_RETRYABLE,
            reconciliationError,
            'Multipart abort reconciliation'
          );
        }
      } else {
        try {
          const upload = await findFileForUser(uploadId, req.user.id);
          if (upload) {
            const object = await inspectCompletedMultipartObject(session, upload);
            if (object.exists) {
              const result = await finalizeMultipartUploadCompletion(
                uploadId,
                req.user.id,
                session.object_key,
                object.storageBytes
              );
              if (result.transitioned || result.session?.status === 'completed') {
                if (result.transitioned) fileQueue.trigger();
                return res.status(409).json({ error: 'Multipart upload was already completed' });
              }
              throw new Error('Multipart completion reconciliation did not transition');
            }
          }
        } catch {
          // Unknown storage outcomes remain retryable below.
        }
      }

      await markMultipartUploadAbortRetryable(
        uploadId,
        req.user.id,
        MULTIPART_ABORT_RETRYABLE
      ).catch(() => undefined);
      return sendUploadError(
        res,
        503,
        MULTIPART_ABORT_RETRYABLE,
        error,
        'Multipart abort storage'
      );
    }

    const result = await finalizeMultipartUploadAbort(uploadId, req.user.id, message);
    if (!result.transitioned && result.session?.status !== 'cancelled') {
      if (result.session?.status === 'completed') {
        return res.status(409).json({ error: 'Multipart upload was already completed' });
      }
      return res.status(409).json({ error: 'Multipart abort state changed' });
    }

    return res.json({ success: true });
  } catch (err) {
    await markMultipartUploadAbortRetryable(
      uploadId,
      req.user.id,
      MULTIPART_ABORT_RETRYABLE
    ).catch(() => undefined);
    return sendUploadError(res, 503, MULTIPART_ABORT_RETRYABLE, err, 'Multipart abort');
  }
};

export const uploadChunk = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { uploadId, chunkIndex } = req.body;
  const file = req.file;
  const parsedChunkIndex = parseUploadChunkIndex(chunkIndex);

  if (!uploadId || parsedChunkIndex === null || !file) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const upload = await findFileForUser(uploadId, req.user.id);
    if (!upload || upload.status !== 'uploading') {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    const declaredSize = Number(upload.file_size);
    const chunkStart = parsedChunkIndex * DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES;
    const chunkEnd = chunkStart + file.buffer.byteLength;
    if (!Number.isSafeInteger(declaredSize) || chunkStart >= declaredSize || chunkEnd > declaredSize) {
      return res.status(413).json({ error: 'Chunk exceeds the reserved document size' });
    }

    // uploadId passed the strict UUID mutation schema and the owner-scoped database lookup above.
    const chunkDir = path.join(UPLOAD_DIR, uploadId); // nosemgrep
    await fs.ensureDir(chunkDir);

    // parsedChunkIndex is a non-negative bounded integer from parseUploadChunkIndex.
    const chunkPath = path.join(chunkDir, parsedChunkIndex.toString()); // nosemgrep
    await fs.writeFile(chunkPath, file.buffer);

    res.json({ success: true });
  } catch (err) {
    return sendUploadError(res, 500, 'Chunk upload failed', err, 'Chunk upload');
  }
};

export const mergeChunks = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { uploadId, filename, totalChunks } = req.body;
  const expectedChunks = parseUploadTotalChunks(totalChunks);
  let chunkDirToCleanup: string | null = null;
  let mergedFilePathToCleanup: string | null = null;
  let completedObjectKey: string | null = null;
  let completedStorageBytes: number | null = null;

  if (!uploadId || !filename || expectedChunks === null) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const contentType = ensureSupportedDocumentFilename(filename);

    const upload = await findFileForUser(uploadId, req.user.id);
    if (!upload || upload.status !== 'uploading') {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    // uploadId passed the strict UUID mutation schema and the owner-scoped database lookup above.
    const chunkDir = path.join(UPLOAD_DIR, uploadId); // nosemgrep
    chunkDirToCleanup = chunkDir;
    if (!await fs.pathExists(chunkDir)) {
      return res.status(400).json({ error: 'Upload session not found' });
    }

    const files = await fs.readdir(chunkDir);
    if (files.length !== expectedChunks) {
      return res.status(400).json({ error: `Missing chunks. Expected ${expectedChunks}, found ${files.length}` });
    }

    files.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

    for (let i = 0; i < expectedChunks; i++) {
      if (!files.includes(i.toString())) {
        return res.status(400).json({ error: `Missing chunk ${i}` });
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

    const objectKey = buildDocumentKey(req.user.id, uploadId, filename);
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
      return sendUploadError(res, 409, message, new Error(message), 'Merge');
    }

    fileQueue.trigger();

    res.json({ success: true, message: 'File merged and queued for processing' });
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
    return sendUploadError(res, isPublicFailure ? 400 : 500, failureMessage, err, 'Merge');
  }
};

export const listFiles = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const requestedProjectSpaceId = readProjectSpaceId(req.query.projectSpaceId || req.query.project_space_id);
    if (requestedProjectSpaceId) {
      const space = await findProjectSpaceForUser(requestedProjectSpaceId, req.user.id);
      if (!space) return res.status(404).json({ error: 'Project space not found' });
    }

    const files = await listFilesForUser(req.user.id, requestedProjectSpaceId);
    res.json(files);
  } catch (err) {
    return sendUploadError(res, 500, 'Failed to fetch files', err, 'File listing');
  }
};

export const getFileContent = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const file = await findFileForUser(id, req.user.id);
    if (!file || file.status !== 'completed' || !file.object_key) {
      return res.status(404).json({ error: 'File content not found' });
    }

    const { stream } = await getObjectStream(file.object_key);

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('Cache-Control', 'private, max-age=60');

    stream.on('error', (error) => {
      console.error('Failed to stream file content:', toSafeError(error, res.locals.requestId));
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read file content' });
      } else {
        res.end();
      }
    });

    stream.pipe(res);
  } catch (err) {
    console.warn('[Upload] File content lookup failed:', toSafeError(err, res.locals?.requestId));
    return res.status(404).json({ error: 'File content not found', details: 'File content not found' });
  }
};

export const retryFileProcessing = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const file = await retryFailedFileForUser(id, req.user.id);
    if (!file) return res.status(404).json({ error: 'Failed file not found' });

    fileQueue.trigger();
    res.json(file);
  } catch (err) {
    return sendUploadError(res, 500, 'Retry failed', err, 'File processing retry');
  }
};

export const deleteFile = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const cleanup = await enqueueFileCleanup(id, req.user.id);
    if (!cleanup) return res.status(404).json({ error: 'File not found' });
    artifactCleanupQueue.trigger();
    res.status(202).json({
      status: 'deleting',
      cleanup_job_id: cleanup.id,
    });
  } catch (err) {
    return sendUploadError(res, 500, 'Internal server error', err, 'File deletion');
  }
};

export const uploadAvatar = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'Avatar file is required' });
  if (!file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'Only image files are supported' });
  }

  const objectKey = buildAvatarKey(req.user.id, file.originalname);
  try {
    await uploadBuffer(objectKey, file.buffer, file.mimetype);

    const avatarUrl = `/api/upload/avatar/${req.user.id}`;
    let replacement;
    try {
      replacement = await replaceUserAvatar(req.user.id, {
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
            toSafeError(queueError, res.locals.requestId)
          );
        }
        console.warn(
          '[Upload] Failed to delete uncommitted avatar object:',
          toSafeError(deleteError, res.locals.requestId)
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
          toSafeError(deleteError, res.locals.requestId)
        );
      }
      artifactCleanupQueue.trigger();
    }

    res.json({ url: avatarUrl, user: replacement.user });
  } catch (err) {
    return sendUploadError(res, 500, 'Avatar upload failed', err, 'Avatar upload');
  }
};

export const getAvatar = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { userId } = req.params;

  if (userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const user = await findUserById(userId);
    if (!user?.avatar_object_key) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    const { stream, contentType } = await getObjectStream(user.avatar_object_key);
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    stream.pipe(res);
  } catch (err) {
    console.warn('[Upload] Avatar lookup failed:', toSafeError(err, res.locals?.requestId));
    return res.status(404).json({ error: 'Avatar not found', details: 'Avatar not found' });
  }
};

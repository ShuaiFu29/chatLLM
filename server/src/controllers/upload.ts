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
  listMultipartObjectParts,
  presignMultipartUploadParts,
  uploadBuffer,
  uploadFilePath,
} from '../lib/storage';
import {
  deleteFileForUser,
  findClaimedFileByUserAndHash,
  findFileForUser,
  listFilesForUser,
  reserveUploadFile,
  retryFailedFileForUser,
  updateFile,
} from '../repositories/files';
import {
  ensureDefaultProjectSpaceForUser,
  findProjectSpaceForUser,
} from '../repositories/projectSpaces';
import { findUserById, updateUser } from '../repositories/users';
import {
  createMultipartUploadSession,
  findActiveMultipartUploadSession,
  findMultipartUploadSessionForUser,
  markMultipartUploadSessionCancelled,
  markMultipartUploadSessionCompleted,
  markMultipartUploadSessionCompleting,
  markMultipartUploadSessionFailed,
  markMultipartUploadSessionUploading,
} from '../repositories/uploadMultipart';
import { fileQueue } from '../services/fileQueue';
import { cleanupRagFileVectors } from '../lib/ragClient';
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

const uploadReservationMessages = {
  DOCUMENT_TOO_LARGE: UPLOAD_TOO_LARGE_ERROR,
  USER_STORAGE_QUOTA_EXCEEDED: 'User storage quota exceeded',
  ACTIVE_UPLOAD_QUOTA_EXCEEDED: 'Active upload quota exceeded',
} as const;

const getUploadReservationMessage = (error: unknown): string | null => {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = error.code;
  if (typeof code !== 'string' || !(code in uploadReservationMessages)) return null;
  return uploadReservationMessages[code as keyof typeof uploadReservationMessages];
};

const getUploadFailureStatus = (inputMessage: string | null, quotaMessage: string | null) => {
  if (quotaMessage || inputMessage === UPLOAD_TOO_LARGE_ERROR) return 413;
  return inputMessage ? 400 : 500;
};

const getMultipartCompletionMessage = (error: unknown): string | null => {
  const message = readErrorMessage(error);
  if (message.startsWith('Missing uploaded parts.')) return 'Missing uploaded parts';
  if (/^Missing uploaded part \d+$/.test(message)) return 'Missing uploaded part';
  if (message.startsWith('Uploaded multipart object size mismatch:')) {
    return 'Uploaded multipart object size mismatch';
  }
  if (message === 'Multipart upload session expired') return message;
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
    console.error(`[Upload] ${operation} failed:`, toSafeError(error, res.locals?.requestId));
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

const assertCompletePartSet = (
  parts: Array<{ partNumber: number; etag: string; size?: number }>,
  expectedTotalParts: number,
  expectedFileSize?: number | null
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

  if (expectedFileSize !== undefined && expectedFileSize !== null && uploadedSize !== Number(expectedFileSize)) {
    throw new Error(`Uploaded multipart object size mismatch: expected ${expectedFileSize}, got ${uploadedSize}`);
  }

  return uploadedSize;
};

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

      const fileDir = path.join(UPLOAD_DIR, fileId);
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
    const quotaMessage = getUploadReservationMessage(err);
    const publicMessage = quotaMessage || inputMessage || 'Init failed';
    return sendUploadError(
      res,
      getUploadFailureStatus(inputMessage, quotaMessage),
      publicMessage,
      err,
      'Init'
    );
  }
};

export const initMultipartUpload = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { filename, hash, size, type } = req.body;
  let createdFileId: string | null = null;

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
      const uploadedParts = await listMultipartObjectParts(activeSession.object_key, activeSession.storage_upload_id)
        .catch(() => []);
      return res.json({
        exists: false,
        uploadNeeded: true,
        uploadStrategy: 'direct-multipart',
        uploadId: file.id,
        partSize: Number(activeSession.part_size),
        totalParts: Number(activeSession.total_parts),
        uploadedPartNumbers: normalizeStorageParts(uploadedParts).map((part) => part.partNumber),
        expiresAt: activeSession.expires_at,
        projectSpaceId,
      });
    }
    createdFileId = file.id;

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
    const expiresAt = new Date(Date.now() + serverEnv.MULTIPART_UPLOAD_SESSION_TTL_MS);
    const session = await createMultipartUploadSession({
      fileId: file.id,
      userId: req.user.id,
      projectSpaceId,
      objectKey,
      storageUploadId,
      partSize,
      totalParts,
      expiresAt,
    });

    res.json({
      exists: false,
      uploadNeeded: true,
      uploadStrategy: 'direct-multipart',
      uploadId: file.id,
      partSize,
      totalParts,
      uploadedPartNumbers: [],
      expiresAt: session.expires_at,
      projectSpaceId,
    });
  } catch (err) {
    const inputMessage = getUploadInputMessage(err);
    const quotaMessage = getUploadReservationMessage(err);
    const failureMessage = quotaMessage || inputMessage || 'Multipart init failed';
    if (createdFileId) {
      await updateFile(createdFileId, {
        status: 'failed',
        progress: 0,
        error_message: failureMessage,
      }).catch(() => undefined);
    }
    return sendUploadError(
      res,
      getUploadFailureStatus(inputMessage, quotaMessage),
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
    if (!session || !['initiated', 'uploading', 'completing'].includes(session.status)) {
      return res.status(404).json({ error: 'Multipart upload session not found' });
    }

    const upload = await findFileForUser(uploadId, req.user.id);
    if (!upload) return res.status(404).json({ error: 'Upload session not found' });
    if (partNumbers.some((partNumber) => partNumber > Number(session.total_parts))) {
      return res.status(400).json({ error: 'Part number exceeds reserved upload' });
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      const message = 'Multipart upload session expired';
      await markMultipartUploadSessionFailed(uploadId, message);
      await updateFile(uploadId, { status: 'failed', progress: 0, error_message: message });
      return res.status(410).json({ error: message });
    }

    await markMultipartUploadSessionUploading(uploadId);
    const parts = await presignMultipartUploadParts(
      session.object_key,
      session.storage_upload_id,
      partNumbers,
      serverEnv.MULTIPART_UPLOAD_URL_EXPIRES_SECONDS,
      {
        partSize: Number(session.part_size),
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
  let completedObjectKey: string | null = null;
  let completedStorageBytes: number | null = null;

  if (!uploadId) {
    return res.status(400).json({ error: 'Missing uploadId' });
  }

  try {
    const upload = await findFileForUser(uploadId, req.user.id);
    if (!upload || upload.status !== 'uploading') {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    const session = await findMultipartUploadSessionForUser(uploadId, req.user.id);
    if (!session || !['initiated', 'uploading', 'completing'].includes(session.status)) {
      return res.status(404).json({ error: 'Multipart upload session not found' });
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw new Error('Multipart upload session expired');
    }

    await markMultipartUploadSessionCompleting(uploadId);
    const storageParts = normalizeStorageParts(
      await listMultipartObjectParts(session.object_key, session.storage_upload_id)
    );
    completedStorageBytes = assertCompletePartSet(storageParts, Number(session.total_parts), upload.file_size);

    await completeMultipartObjectUpload(session.object_key, session.storage_upload_id, storageParts);
    completedObjectKey = session.object_key;

    await updateFile(uploadId, {
      status: 'pending',
      object_key: session.object_key,
      progress: 0,
      error_message: null,
      reserved_bytes: 0,
      storage_bytes: completedStorageBytes,
    });
    await markMultipartUploadSessionCompleted(uploadId);

    fileQueue.trigger();

    res.json({ success: true, message: 'File uploaded and queued for processing' });
  } catch (err) {
    const completionMessage = getMultipartCompletionMessage(err);
    const failureMessage = completionMessage || 'Multipart complete failed';
    await markMultipartUploadSessionFailed(uploadId, failureMessage).catch(() => undefined);
    const failedUpdate: Parameters<typeof updateFile>[1] = {
      status: 'failed',
      progress: 0,
      error_message: failureMessage,
    };
    if (completedObjectKey && completedStorageBytes !== null) {
      failedUpdate.object_key = completedObjectKey;
      failedUpdate.reserved_bytes = 0;
      failedUpdate.storage_bytes = completedStorageBytes;
    }
    await updateFile(uploadId, failedUpdate).catch(() => undefined);
    return sendUploadError(res, completionMessage ? 400 : 500, failureMessage, err, 'Multipart complete');
  }
};

export const abortMultipartUpload = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { uploadId } = req.body;

  if (!uploadId) {
    return res.status(400).json({ error: 'Missing uploadId' });
  }

  try {
    const session = await findMultipartUploadSessionForUser(uploadId, req.user.id);
    if (!session) return res.status(404).json({ error: 'Multipart upload session not found' });

    if (['initiated', 'uploading', 'completing'].includes(session.status)) {
      await abortMultipartObjectUpload(session.object_key, session.storage_upload_id);
    }

    const message = 'Multipart upload cancelled';
    await markMultipartUploadSessionCancelled(uploadId, message);
    await updateFile(uploadId, {
      status: 'failed',
      progress: 0,
      error_message: message,
      reserved_bytes: 0,
      storage_bytes: 0,
    });

    res.json({ success: true });
  } catch (err) {
    return sendUploadError(res, 500, 'Multipart abort failed', err, 'Multipart abort');
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

    const chunkDir = path.join(UPLOAD_DIR, uploadId);
    await fs.ensureDir(chunkDir);

    const chunkPath = path.join(chunkDir, parsedChunkIndex.toString());
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

    const chunkDir = path.join(UPLOAD_DIR, uploadId);
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

    const mergedFilePath = path.join(UPLOAD_DIR, `${uploadId}_merged`);
    mergedFilePathToCleanup = mergedFilePath;
    const writeStream = fs.createWriteStream(mergedFilePath);

    for (let i = 0; i < expectedChunks; i++) {
      const chunkPath = path.join(chunkDir, i.toString());
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

    await updateFile(uploadId, {
      status: 'pending',
      object_key: objectKey,
      progress: 0,
      error_message: null,
      reserved_bytes: 0,
      storage_bytes: digest.size,
    });

    await fs.remove(chunkDir);
    await fs.remove(mergedFilePath);

    fileQueue.trigger();

    res.json({ success: true, message: 'File merged and queued for processing' });
  } catch (err) {
    const inputMessage = getUploadInputMessage(err);
    const integrityMessage = getMergeIntegrityMessage(err);
    const failureMessage = inputMessage || integrityMessage || 'Merge failed';
    const isIntegrityFailure = Boolean(integrityMessage || inputMessage === UPLOAD_HASH_ERROR);
    if (completedObjectKey && completedStorageBytes !== null) {
      await updateFile(uploadId, {
        status: 'failed',
        object_key: completedObjectKey,
        progress: 0,
        error_message: failureMessage,
        reserved_bytes: 0,
        storage_bytes: completedStorageBytes,
      }).catch(() => undefined);
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
    const file = await findFileForUser(id, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    try {
      await cleanupRagFileVectors(file.id);
    } catch (err) {
      return sendUploadError(
        res,
        502,
        'Vector cleanup failed; file was not deleted',
        err,
        'Vector cleanup'
      );
    }

    if (file.object_key) {
      await deleteObject(file.object_key);
    }
    const deleted = await deleteFileForUser(id, req.user.id);

    if (!deleted) return res.status(404).json({ error: 'File not found' });

    res.json({ message: 'File deleted successfully' });
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

  try {
    const currentUser = await findUserById(req.user.id);
    const objectKey = buildAvatarKey(req.user.id, file.originalname);
    await uploadBuffer(objectKey, file.buffer, file.mimetype);

    if (currentUser?.avatar_object_key) {
      await deleteObject(currentUser.avatar_object_key).catch((err) => {
        console.warn('[Upload] Failed to delete old avatar object:', toSafeError(err, res.locals.requestId));
      });
    }

    const avatarUrl = `/api/upload/avatar/${req.user.id}`;
    const user = await updateUser(req.user.id, {
      avatar_url: avatarUrl,
      avatar_object_key: objectKey,
    });

    res.json({ url: avatarUrl, user });
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

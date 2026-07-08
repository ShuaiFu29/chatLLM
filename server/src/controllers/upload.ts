import { Request, Response } from 'express';
import axios from 'axios';
import path from 'path';
import fs from 'fs-extra';
import { pipeline } from 'stream/promises';
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
  createUploadFile,
  deleteFileForUser,
  findCompletedFileByUserAndHash,
  findFileForUser,
  findUploadingFileByUserAndHash,
  listFilesForUser,
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
  chooseMultipartPartSize,
  getSupportedDocumentContentType,
  parseMultipartPartNumbers,
  parseUploadFileHash,
  parseUploadFileSize,
  parseUploadChunkIndex,
  parseUploadTotalChunks,
} from '../lib/uploadInput';
import { serverEnv } from '../lib/env';

const UPLOAD_DIR = path.join(__dirname, '../../uploads/temp');
fs.ensureDirSync(UPLOAD_DIR);

const stringifyError = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    return `${error.name}: ${error.message}${error.response?.data ? ` | ${JSON.stringify(error.response.data)}` : ''}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const maybeMessage = (error as any).message;
    if (typeof maybeMessage === 'string') return maybeMessage;
    try {
      return JSON.stringify(error);
    } catch {
      return '[Unserializable error object]';
    }
  }
  return String(error);
};

const ensureSupportedDocumentFilename = (filename?: string) => {
  const contentType = getSupportedDocumentContentType(filename);
  if (!contentType) {
    throw new Error(SUPPORTED_DOCUMENT_ERROR);
  }
  return contentType;
};

const isUnsupportedDocumentMessage = (message: string) => message.includes(SUPPORTED_DOCUMENT_ERROR);
const isUploadInputMessage = (message: string) => (
  isUnsupportedDocumentMessage(message)
  || message.includes(UPLOAD_HASH_ERROR)
  || message.includes(UPLOAD_SIZE_ERROR)
);

const requireUploadHash = (value: unknown) => {
  const hash = parseUploadFileHash(value);
  if (!hash) throw new Error(UPLOAD_HASH_ERROR);
  return hash;
};

const requireUploadSize = (value: unknown) => {
  const size = parseUploadFileSize(value);
  if (size === null) throw new Error(UPLOAD_SIZE_ERROR);
  return size;
};

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

  if (expectedFileSize !== undefined && expectedFileSize !== null) {
    const partSizes = parts.map((part) => Number(part.size));
    if (partSizes.every((size) => Number.isFinite(size) && size >= 0)) {
      const uploadedSize = partSizes.reduce((sum, size) => sum + size, 0);
      if (uploadedSize !== expectedFileSize) {
        throw new Error(`Uploaded multipart object size mismatch: expected ${expectedFileSize}, got ${uploadedSize}`);
      }
    }
  }
};

export const checkFile = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { hash, filename } = req.body;

  try {
    const normalizedHash = requireUploadHash(hash);
    ensureSupportedDocumentFilename(filename);
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.status(404).json({ error: 'Project space not found' });

    const existingFile = await findCompletedFileByUserAndHash(req.user.id, normalizedHash, projectSpaceId);

    if (existingFile) {
      return res.json({
        exists: true,
        uploadNeeded: false,
        fileId: existingFile.id,
        projectSpaceId,
      });
    }

    const pendingFile = await findUploadingFileByUserAndHash(req.user.id, normalizedHash, projectSpaceId);
    const fileId = pendingFile?.id;
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
    const message = stringifyError(err);
    const status = isUploadInputMessage(message) ? 400 : 500;
    res.status(status).json({ error: status === 400 ? message : 'Check failed', details: message });
  }
};

export const initUpload = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { filename, hash, size, type } = req.body;

  try {
    const normalizedHash = requireUploadHash(hash);
    const normalizedSize = requireUploadSize(size);
    const contentType = ensureSupportedDocumentFilename(filename);
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.status(404).json({ error: 'Project space not found' });

    const file = await createUploadFile({
      userId: req.user.id,
      projectSpaceId,
      filename,
      hash: normalizedHash,
      size: normalizedSize,
      type: getSupportedDocumentContentType(filename) || type || contentType,
    });

    res.json({ uploadId: file.id, projectSpaceId });
  } catch (err) {
    const message = stringifyError(err);
    const status = isUploadInputMessage(message) ? 400 : 500;
    res.status(status).json({ error: status === 400 ? message : 'Init failed', details: message });
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
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.status(404).json({ error: 'Project space not found' });

    const existingFile = await findCompletedFileByUserAndHash(req.user.id, normalizedHash, projectSpaceId);
    if (existingFile) {
      return res.json({
        exists: true,
        uploadNeeded: false,
        uploadId: existingFile.id,
        projectSpaceId,
      });
    }

    const uploadingFile = await findUploadingFileByUserAndHash(req.user.id, normalizedHash, projectSpaceId);
    let file = uploadingFile
      ? await findFileForUser(uploadingFile.id, req.user.id)
      : null;

    if (file) {
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
    }

    if (!file) {
      file = await createUploadFile({
        userId: req.user.id,
        projectSpaceId,
        filename,
        hash: normalizedHash,
        size: normalizedSize,
        type: getSupportedDocumentContentType(filename) || type || contentType,
      });
      createdFileId = file.id;
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
    const message = stringifyError(err);
    if (createdFileId) {
      await updateFile(createdFileId, {
        status: 'failed',
        progress: 0,
        error_message: message,
      }).catch(() => undefined);
    }
    const status = isUploadInputMessage(message) ? 400 : 500;
    res.status(status).json({ error: status === 400 ? message : 'Multipart init failed', details: message });
  }
};

export const presignMultipartParts = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { uploadId } = req.body;
  const partNumbers = parseMultipartPartNumbers(req.body.partNumbers || req.body.part_numbers);

  if (!uploadId || !partNumbers) {
    return res.status(400).json({ error: 'Missing multipart upload parameters' });
  }

  try {
    const session = await findMultipartUploadSessionForUser(uploadId, req.user.id);
    if (!session || !['initiated', 'uploading', 'completing'].includes(session.status)) {
      return res.status(404).json({ error: 'Multipart upload session not found' });
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
      serverEnv.MULTIPART_UPLOAD_URL_EXPIRES_SECONDS
    );

    res.json({
      uploadId,
      expiresIn: serverEnv.MULTIPART_UPLOAD_URL_EXPIRES_SECONDS,
      parts,
    });
  } catch (err) {
    res.status(500).json({ error: 'Multipart presign failed', details: stringifyError(err) });
  }
};

export const completeMultipartUpload = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { uploadId } = req.body;
  let completedObjectKey: string | null = null;

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
    assertCompletePartSet(storageParts, Number(session.total_parts), upload.file_size);

    await completeMultipartObjectUpload(session.object_key, session.storage_upload_id, storageParts);
    completedObjectKey = session.object_key;

    await updateFile(uploadId, {
      status: 'pending',
      object_key: session.object_key,
      progress: 0,
      error_message: null,
    });
    await markMultipartUploadSessionCompleted(uploadId);

    fileQueue.trigger();

    res.json({ success: true, message: 'File uploaded and queued for processing' });
  } catch (err) {
    const message = stringifyError(err);
    await markMultipartUploadSessionFailed(uploadId, message).catch(() => undefined);
    const failedUpdate: Parameters<typeof updateFile>[1] = {
      status: 'failed',
      progress: 0,
      error_message: message,
    };
    if (completedObjectKey) {
      failedUpdate.object_key = completedObjectKey;
    }
    await updateFile(uploadId, failedUpdate).catch(() => undefined);
    const status = /Missing uploaded parts|Missing uploaded part|size mismatch|expired/i.test(message) ? 400 : 500;
    res.status(status).json({ error: status === 400 ? message : 'Multipart complete failed', details: message });
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
      await abortMultipartObjectUpload(session.object_key, session.storage_upload_id).catch(() => undefined);
    }

    const message = 'Multipart upload cancelled';
    await markMultipartUploadSessionCancelled(uploadId, message);
    await updateFile(uploadId, {
      status: 'failed',
      progress: 0,
      error_message: message,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Multipart abort failed', details: stringifyError(err) });
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

    const chunkDir = path.join(UPLOAD_DIR, uploadId);
    await fs.ensureDir(chunkDir);

    const chunkPath = path.join(chunkDir, parsedChunkIndex.toString());
    await fs.writeFile(chunkPath, file.buffer);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Chunk upload failed', details: stringifyError(err) });
  }
};

export const mergeChunks = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { uploadId, filename, totalChunks } = req.body;
  const expectedChunks = parseUploadTotalChunks(totalChunks);
  let chunkDirToCleanup: string | null = null;
  let mergedFilePathToCleanup: string | null = null;

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

    await verifyMergedUploadFile(mergedFilePath, {
      expectedHash: upload.file_hash,
      expectedSize: upload.file_size,
    });

    const objectKey = buildDocumentKey(req.user.id, uploadId, filename);
    await uploadFilePath(objectKey, mergedFilePath, upload.file_type || contentType);

    await updateFile(uploadId, {
      status: 'pending',
      object_key: objectKey,
      progress: 0,
      error_message: null,
    });

    await fs.remove(chunkDir);
    await fs.remove(mergedFilePath);

    fileQueue.trigger();

    res.json({ success: true, message: 'File merged and queued for processing' });
  } catch (err) {
    const message = stringifyError(err);
    const isIntegrityFailure = /hash mismatch|size mismatch|SHA-256 file hash/i.test(message);
    if (isIntegrityFailure) {
      await Promise.all([
        chunkDirToCleanup ? fs.remove(chunkDirToCleanup).catch(() => undefined) : Promise.resolve(),
        mergedFilePathToCleanup ? fs.remove(mergedFilePathToCleanup).catch(() => undefined) : Promise.resolve(),
      ]);
      await updateFile(uploadId, {
        status: 'failed',
        progress: 0,
        error_message: message,
      }).catch(() => undefined);
    }
    const status = isUploadInputMessage(message) || isIntegrityFailure ? 400 : 500;
    res.status(status).json({ error: status === 400 ? message : 'Merge failed', details: message });
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
    res.status(500).json({ error: 'Failed to fetch files', details: stringifyError(err) });
  }
};

export const getFileContent = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const file = await findFileForUser(id, req.user.id);
    if (!file || !file.object_key) {
      return res.status(404).json({ error: 'File content not found' });
    }

    const { stream } = await getObjectStream(file.object_key);

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('Cache-Control', 'private, max-age=60');

    stream.on('error', (error) => {
      console.error('Failed to stream file content:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read file content' });
      } else {
        res.end();
      }
    });

    stream.pipe(res);
  } catch (err) {
    res.status(404).json({ error: 'File content not found', details: stringifyError(err) });
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
    res.status(500).json({ error: 'Retry failed', details: stringifyError(err) });
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
      return res.status(502).json({
        error: 'Vector cleanup failed; file was not deleted',
        details: stringifyError(err),
      });
    }

    if (file.object_key) {
      await deleteObject(file.object_key);
    }
    const deleted = await deleteFileForUser(id, req.user.id);

    if (!deleted) return res.status(404).json({ error: 'File not found' });

    res.json({ message: 'File deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', details: stringifyError(err) });
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
        console.warn('[Upload] Failed to delete old avatar object:', stringifyError(err));
      });
    }

    const avatarUrl = `/api/upload/avatar/${req.user.id}`;
    const user = await updateUser(req.user.id, {
      avatar_url: avatarUrl,
      avatar_object_key: objectKey,
    });

    res.json({ url: avatarUrl, user });
  } catch (err) {
    res.status(500).json({ error: 'Avatar upload failed', details: stringifyError(err) });
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
    res.status(404).json({ error: 'Avatar not found', details: stringifyError(err) });
  }
};

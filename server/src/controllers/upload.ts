import { Request, Response } from 'express';
import axios from 'axios';
import path from 'path';
import fs from 'fs-extra';
import {
  buildAvatarKey,
  buildDocumentKey,
  deleteObject,
  getObjectStream,
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
import { fileQueue } from '../services/fileQueue';
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

const ensureMarkdownFilename = (filename?: string) => {
  if (!filename || !filename.toLowerCase().endsWith('.md')) {
    throw new Error('Only .md files are supported');
  }
};

const cleanupFileVectors = async (fileId: string) => {
  await axios.post(`${serverEnv.RAG_SERVICE_URL}/cleanup-file`, { file_id: fileId }, { timeout: 10000 });
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

export const checkFile = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { hash, filename } = req.body;
  if (!hash) return res.status(400).json({ error: 'Hash is required' });

  try {
    ensureMarkdownFilename(filename);
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.status(404).json({ error: 'Project space not found' });

    const existingFile = await findCompletedFileByUserAndHash(req.user.id, hash, projectSpaceId);

    if (existingFile) {
      return res.json({
        exists: true,
        uploadNeeded: false,
        fileId: existingFile.id,
        projectSpaceId,
      });
    }

    const pendingFile = await findUploadingFileByUserAndHash(req.user.id, hash, projectSpaceId);
    const fileId = pendingFile?.id;
    let uploadedChunks: number[] = [];

    if (fileId) {
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
      projectSpaceId,
    });
  } catch (err) {
    const message = stringifyError(err);
    const status = message.includes('Only .md') ? 400 : 500;
    res.status(status).json({ error: status === 400 ? message : 'Check failed', details: message });
  }
};

export const initUpload = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { filename, hash, size, type } = req.body;

  try {
    ensureMarkdownFilename(filename);
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.status(404).json({ error: 'Project space not found' });

    const file = await createUploadFile({
      userId: req.user.id,
      projectSpaceId,
      filename,
      hash,
      size,
      type: type || 'text/markdown',
    });

    res.json({ uploadId: file.id, projectSpaceId });
  } catch (err) {
    const message = stringifyError(err);
    const status = message.includes('Only .md') ? 400 : 500;
    res.status(status).json({ error: status === 400 ? message : 'Init failed', details: message });
  }
};

export const uploadChunk = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { uploadId, chunkIndex } = req.body;
  const file = req.file;
  const parsedChunkIndex = Number.parseInt(chunkIndex, 10);

  if (!uploadId || Number.isNaN(parsedChunkIndex) || !file) {
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
  const expectedChunks = Number.parseInt(totalChunks, 10);

  if (!uploadId || !filename || Number.isNaN(expectedChunks)) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    ensureMarkdownFilename(filename);

    const upload = await findFileForUser(uploadId, req.user.id);
    if (!upload || upload.status !== 'uploading') {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    const chunkDir = path.join(UPLOAD_DIR, uploadId);
    if (!await fs.pathExists(chunkDir)) {
      return res.status(400).json({ error: 'Upload session not found' });
    }

    const files = await fs.readdir(chunkDir);
    if (files.length !== expectedChunks) {
      return res.status(400).json({ error: `Missing chunks. Expected ${expectedChunks}, found ${files.length}` });
    }

    files.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

    const mergedFilePath = path.join(UPLOAD_DIR, `${uploadId}_merged`);
    const writeStream = fs.createWriteStream(mergedFilePath);

    for (let i = 0; i < expectedChunks; i++) {
      if (!files.includes(i.toString())) {
        writeStream.destroy();
        return res.status(400).json({ error: `Missing chunk ${i}` });
      }

      const chunkPath = path.join(chunkDir, i.toString());
      const chunkBuffer = await fs.readFile(chunkPath);
      writeStream.write(chunkBuffer);
    }

    writeStream.end();

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const objectKey = buildDocumentKey(req.user.id, uploadId, filename);
    await uploadFilePath(objectKey, mergedFilePath, upload.file_type || 'text/markdown');

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
    res.status(500).json({ error: 'Merge failed', details: stringifyError(err) });
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
      await cleanupFileVectors(file.id);
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

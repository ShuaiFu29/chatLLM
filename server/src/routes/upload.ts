import express from 'express';
import {
  checkFile,
  abortMultipartUpload,
  completeMultipartUpload,
  initMultipartUpload,
  presignMultipartParts,
  initUpload,
  uploadChunk,
  mergeChunks,
  listFiles,
  getFileContent,
  deleteFile,
  retryFileProcessing,
  uploadAvatar,
  getAvatar,
} from '../controllers/upload';
import { requireAuth } from '../middleware/auth';
import { handleUploadError } from '../middleware/uploadErrors';
import { avatarUpload, chunkUpload } from '../lib/uploadMiddleware';

const router = express.Router();

router.use(requireAuth);

router.post('/check', checkFile);
router.post('/init', initUpload);
router.post('/multipart/init', initMultipartUpload);
router.post('/multipart/parts', presignMultipartParts);
router.post('/multipart/complete', completeMultipartUpload);
router.post('/multipart/abort', abortMultipartUpload);
router.post('/chunk', chunkUpload.single('chunk'), uploadChunk);
router.post('/merge', mergeChunks);
router.post('/avatar', avatarUpload.single('file'), uploadAvatar);
router.get('/avatar/:userId', getAvatar);
router.get('/files', listFiles);
router.get('/files/:id/content', getFileContent);
router.post('/files/:id/retry', retryFileProcessing);
router.delete('/files/:id', deleteFile);
router.use(handleUploadError);

export default router;

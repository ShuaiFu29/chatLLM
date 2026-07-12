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
import { mutationSchemas } from '../lib/mutationSchemas';
import { requireAuth } from '../middleware/auth';
import { handleUploadError } from '../middleware/uploadErrors';
import { avatarUpload, chunkUpload } from '../lib/uploadMiddleware';
import { validateMutation } from '../lib/validation';

const router = express.Router();

router.use(requireAuth);

router.post('/check', validateMutation(mutationSchemas.uploadCheck), checkFile);
router.post('/init', validateMutation(mutationSchemas.uploadInit), initUpload);
router.post('/multipart/init', validateMutation(mutationSchemas.uploadMultipartInit), initMultipartUpload);
router.post('/multipart/parts', validateMutation(mutationSchemas.uploadMultipartParts), presignMultipartParts);
router.post('/multipart/complete', validateMutation(mutationSchemas.uploadMultipartComplete), completeMultipartUpload);
router.post('/multipart/abort', validateMutation(mutationSchemas.uploadMultipartAbort), abortMultipartUpload);
router.post('/chunk', chunkUpload.single('chunk'), validateMutation(mutationSchemas.uploadChunk), uploadChunk);
router.post('/merge', validateMutation(mutationSchemas.uploadMerge), mergeChunks);
router.post('/avatar', avatarUpload.single('file'), validateMutation(mutationSchemas.uploadAvatar), uploadAvatar);
router.get('/avatar/:userId', getAvatar);
router.get('/files', listFiles);
router.get('/files/:id/content', getFileContent);
router.post('/files/:id/retry', validateMutation(mutationSchemas.uploadRetryFile), retryFileProcessing);
router.delete('/files/:id', validateMutation(mutationSchemas.uploadDeleteFile), deleteFile);
router.use(handleUploadError);

export default router;

import express from 'express';
import { checkFile, initUpload, uploadChunk, mergeChunks, listFiles, deleteFile, uploadAvatar, getAvatar } from '../controllers/upload';
import { requireAuth } from '../middleware/auth';
import { handleUploadError } from '../middleware/uploadErrors';
import { avatarUpload, chunkUpload } from '../lib/uploadMiddleware';

const router = express.Router();

router.use(requireAuth);

router.post('/check', checkFile);
router.post('/init', initUpload);
router.post('/chunk', chunkUpload.single('chunk'), uploadChunk);
router.post('/merge', mergeChunks);
router.post('/avatar', avatarUpload.single('file'), uploadAvatar);
router.get('/avatar/:userId', getAvatar);
router.get('/files', listFiles);
router.delete('/files/:id', deleteFile);
router.use(handleUploadError);

export default router;

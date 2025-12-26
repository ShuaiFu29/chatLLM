import express from 'express';
import multer from 'multer';
import { checkFile, initUpload, uploadChunk, mergeChunks, listFiles, deleteFile } from '../controllers/upload';
import { requireAuth } from '../middleware/auth';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() }); // Keep in memory for chunk handling

router.use(requireAuth);

router.post('/check', checkFile);
router.post('/init', initUpload);
router.post('/chunk', upload.single('chunk'), uploadChunk);
router.post('/merge', mergeChunks);
router.get('/files', listFiles);
router.delete('/files/:id', deleteFile);

export default router;

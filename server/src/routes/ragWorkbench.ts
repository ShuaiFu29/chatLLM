import { Router } from 'express';
import { inspectRagRetrieval, searchRagGraph } from '../controllers/ragWorkbench';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.post('/inspect', requireAuth, inspectRagRetrieval);
router.post('/graph/search', requireAuth, searchRagGraph);

export default router;

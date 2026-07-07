import { Router } from 'express';
import { inspectRagRetrieval, listRagGraph, searchRagGraph } from '../controllers/ragWorkbench';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.post('/inspect', requireAuth, inspectRagRetrieval);
router.post('/graph/list', requireAuth, listRagGraph);
router.post('/graph/search', requireAuth, searchRagGraph);

export default router;

import { Router } from 'express';
import { inspectRagRetrieval, listRagGraph, searchRagGraph } from '../controllers/ragWorkbench';
import { mutationSchemas } from '../lib/mutationSchemas';
import { validateMutation } from '../lib/validation';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.post('/inspect', requireAuth, validateMutation(mutationSchemas.ragWorkbenchInspect), inspectRagRetrieval);
router.post('/graph/list', requireAuth, validateMutation(mutationSchemas.ragWorkbenchGraphList), listRagGraph);
router.post('/graph/search', requireAuth, validateMutation(mutationSchemas.ragWorkbenchGraphSearch), searchRagGraph);

export default router;

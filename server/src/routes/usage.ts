import { Router } from 'express';
import { getUsageConversation, getUsageFileQueue, getUsageOverview } from '../controllers/usage';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, getUsageOverview);
router.get('/file-queue', requireAuth, getUsageFileQueue);
router.get('/conversations/:conversationId', requireAuth, getUsageConversation);

export default router;

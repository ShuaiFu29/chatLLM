import { Router } from 'express';
import { getConversations, createConversation, updateConversation, deleteConversation, getMessages, sendMessage, searchMessages } from '../controllers/chat';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/search', requireAuth, searchMessages);

router.get('/conversations', requireAuth, getConversations);
router.post('/conversations', requireAuth, createConversation);
router.patch('/conversations/:conversationId', requireAuth, updateConversation);
router.delete('/conversations/:conversationId', requireAuth, deleteConversation);

router.delete('/messages/:messageId', requireAuth, (req, res, next) => {
  import('../controllers/chat').then(mod => mod.deleteMessage(req, res)).catch(next);
});
router.get('/conversations/:conversationId/messages', requireAuth, getMessages);
router.post('/conversations/:conversationId/messages', requireAuth, sendMessage);

export default router;

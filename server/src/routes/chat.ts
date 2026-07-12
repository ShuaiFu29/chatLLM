import { Router } from 'express';
import { getConversations, createConversation, updateConversation, deleteConversation, getMessages, sendMessage, searchMessages, branchConversation, compareConversations, truncateConversation } from '../controllers/chat';
import { mutationSchemas } from '../lib/mutationSchemas';
import { validateMutation } from '../lib/validation';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/search', requireAuth, searchMessages);

router.get('/conversations', requireAuth, getConversations);
router.post('/conversations', requireAuth, validateMutation(mutationSchemas.chatCreateConversation), createConversation);
router.post('/conversations/:conversationId/branches', requireAuth, validateMutation(mutationSchemas.chatBranchConversation), branchConversation);
router.get('/conversations/:conversationId/compare/:otherConversationId', requireAuth, compareConversations);
router.patch('/conversations/:conversationId', requireAuth, validateMutation(mutationSchemas.chatUpdateConversation), updateConversation);
router.delete('/conversations/:conversationId', requireAuth, validateMutation(mutationSchemas.chatDeleteConversation), deleteConversation);

router.delete('/messages/:messageId', requireAuth, validateMutation(mutationSchemas.chatDeleteMessage), (req, res, next) => {
  import('../controllers/chat').then(mod => mod.deleteMessage(req, res)).catch(next);
});
router.delete('/conversations/:conversationId/messages/:messageId/truncate', requireAuth, validateMutation(mutationSchemas.chatTruncateConversation), truncateConversation);
router.get('/conversations/:conversationId/messages', requireAuth, getMessages);
router.post('/conversations/:conversationId/messages', requireAuth, validateMutation(mutationSchemas.chatSendMessage), sendMessage);

export default router;

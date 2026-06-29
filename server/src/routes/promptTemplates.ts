import { Router } from 'express';
import {
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
  updatePromptTemplate,
} from '../controllers/promptTemplates';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, listPromptTemplates);
router.post('/', requireAuth, createPromptTemplate);
router.patch('/:templateId', requireAuth, updatePromptTemplate);
router.delete('/:templateId', requireAuth, deletePromptTemplate);

export default router;

import { Router } from 'express';
import {
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
  updatePromptTemplate,
} from '../controllers/promptTemplates';
import { mutationSchemas } from '../lib/mutationSchemas';
import { validateMutation } from '../lib/validation';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, listPromptTemplates);
router.post('/', requireAuth, validateMutation(mutationSchemas.promptTemplateCreate), createPromptTemplate);
router.patch('/:templateId', requireAuth, validateMutation(mutationSchemas.promptTemplateUpdate), updatePromptTemplate);
router.delete('/:templateId', requireAuth, validateMutation(mutationSchemas.promptTemplateDelete), deletePromptTemplate);

export default router;

import { Router } from 'express';
import {
  analyzePersonaCenter,
  getPersonaCenter,
  resetPersonaCenter,
  updatePersonaInterest,
  updatePersonaProfile,
  updatePersonaSuggestion,
} from '../controllers/persona';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, getPersonaCenter);
router.post('/analyze', requireAuth, analyzePersonaCenter);
router.patch('/profile', requireAuth, updatePersonaProfile);
router.patch('/interests/:interestId', requireAuth, updatePersonaInterest);
router.patch('/suggestions/:suggestionId', requireAuth, updatePersonaSuggestion);
router.post('/reset', requireAuth, resetPersonaCenter);

export default router;

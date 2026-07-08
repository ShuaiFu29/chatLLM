import { Router } from 'express';
import {
  analyzePersonaCenter,
  deletePersonaInterest,
  deletePersonaObservation,
  deletePersonaProfile,
  deletePersonaSuggestion,
  getPersonaCenter,
  resetPersonaCenter,
  updatePersonaInterest,
  updatePersonaObservation,
  updatePersonaProfile,
  updatePersonaSuggestion,
} from '../controllers/persona';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, getPersonaCenter);
router.post('/analyze', requireAuth, analyzePersonaCenter);
router.patch('/profile', requireAuth, updatePersonaProfile);
router.delete('/profile', requireAuth, deletePersonaProfile);
router.patch('/interests/:interestId', requireAuth, updatePersonaInterest);
router.delete('/interests/:interestId', requireAuth, deletePersonaInterest);
router.patch('/observations/:observationId', requireAuth, updatePersonaObservation);
router.delete('/observations/:observationId', requireAuth, deletePersonaObservation);
router.patch('/suggestions/:suggestionId', requireAuth, updatePersonaSuggestion);
router.delete('/suggestions/:suggestionId', requireAuth, deletePersonaSuggestion);
router.post('/reset', requireAuth, resetPersonaCenter);

export default router;

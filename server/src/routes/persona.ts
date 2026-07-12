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
import { mutationSchemas } from '../lib/mutationSchemas';
import { validateMutation } from '../lib/validation';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, getPersonaCenter);
router.post('/analyze', requireAuth, validateMutation(mutationSchemas.personaAnalyze), analyzePersonaCenter);
router.patch('/profile', requireAuth, validateMutation(mutationSchemas.personaUpdateProfile), updatePersonaProfile);
router.delete('/profile', requireAuth, validateMutation(mutationSchemas.personaDeleteProfile), deletePersonaProfile);
router.patch('/interests/:interestId', requireAuth, validateMutation(mutationSchemas.personaUpdateInterest), updatePersonaInterest);
router.delete('/interests/:interestId', requireAuth, validateMutation(mutationSchemas.personaDeleteInterest), deletePersonaInterest);
router.patch('/observations/:observationId', requireAuth, validateMutation(mutationSchemas.personaUpdateObservation), updatePersonaObservation);
router.delete('/observations/:observationId', requireAuth, validateMutation(mutationSchemas.personaDeleteObservation), deletePersonaObservation);
router.patch('/suggestions/:suggestionId', requireAuth, validateMutation(mutationSchemas.personaUpdateSuggestion), updatePersonaSuggestion);
router.delete('/suggestions/:suggestionId', requireAuth, validateMutation(mutationSchemas.personaDeleteSuggestion), deletePersonaSuggestion);
router.post('/reset', requireAuth, validateMutation(mutationSchemas.personaReset), resetPersonaCenter);

export default router;

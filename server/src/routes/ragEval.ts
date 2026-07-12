import { Router } from 'express';
import {
  cancelRagEvalRun,
  createRagEvalCase,
  createRagEvalDataset,
  deleteRagEvalCase,
  deleteRagEvalDataset,
  getRagEvalQualitySummary,
  getRagEvalRun,
  listRagEvalDatasets,
  listRagEvalHistory,
  runRagEvalDataset,
  updateRagEvalDataset,
} from '../controllers/ragEval';
import { mutationSchemas } from '../lib/mutationSchemas';
import { validateMutation } from '../lib/validation';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/history', requireAuth, listRagEvalHistory);
router.get('/datasets', requireAuth, listRagEvalDatasets);
router.post('/datasets', requireAuth, validateMutation(mutationSchemas.ragEvalDatasetCreate), createRagEvalDataset);
router.patch('/datasets/:datasetId', requireAuth, validateMutation(mutationSchemas.ragEvalDatasetUpdate), updateRagEvalDataset);
router.delete('/datasets/:datasetId', requireAuth, validateMutation(mutationSchemas.ragEvalDatasetDelete), deleteRagEvalDataset);
router.get('/datasets/:datasetId/quality', requireAuth, getRagEvalQualitySummary);
router.post('/datasets/:datasetId/cases', requireAuth, validateMutation(mutationSchemas.ragEvalCaseCreate), createRagEvalCase);
router.post('/datasets/:datasetId/runs', requireAuth, validateMutation(mutationSchemas.ragEvalDatasetRun), runRagEvalDataset);
router.get('/runs/:runId', requireAuth, getRagEvalRun);
router.post('/runs/:runId/cancel', requireAuth, validateMutation(mutationSchemas.ragEvalRunCancel), cancelRagEvalRun);
router.delete('/cases/:caseId', requireAuth, validateMutation(mutationSchemas.ragEvalCaseDelete), deleteRagEvalCase);

export default router;

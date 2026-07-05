import { Router } from 'express';
import {
  createRagEvalCase,
  createRagEvalDataset,
  deleteRagEvalCase,
  deleteRagEvalDataset,
  getRagEvalRun,
  listRagEvalDatasets,
  runRagEvalDataset,
  updateRagEvalDataset,
} from '../controllers/ragEval';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/datasets', requireAuth, listRagEvalDatasets);
router.post('/datasets', requireAuth, createRagEvalDataset);
router.patch('/datasets/:datasetId', requireAuth, updateRagEvalDataset);
router.delete('/datasets/:datasetId', requireAuth, deleteRagEvalDataset);
router.post('/datasets/:datasetId/cases', requireAuth, createRagEvalCase);
router.post('/datasets/:datasetId/runs', requireAuth, runRagEvalDataset);
router.get('/runs/:runId', requireAuth, getRagEvalRun);
router.delete('/cases/:caseId', requireAuth, deleteRagEvalCase);

export default router;

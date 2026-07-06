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
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/history', requireAuth, listRagEvalHistory);
router.get('/datasets', requireAuth, listRagEvalDatasets);
router.post('/datasets', requireAuth, createRagEvalDataset);
router.patch('/datasets/:datasetId', requireAuth, updateRagEvalDataset);
router.delete('/datasets/:datasetId', requireAuth, deleteRagEvalDataset);
router.get('/datasets/:datasetId/quality', requireAuth, getRagEvalQualitySummary);
router.post('/datasets/:datasetId/cases', requireAuth, createRagEvalCase);
router.post('/datasets/:datasetId/runs', requireAuth, runRagEvalDataset);
router.get('/runs/:runId', requireAuth, getRagEvalRun);
router.post('/runs/:runId/cancel', requireAuth, cancelRagEvalRun);
router.delete('/cases/:caseId', requireAuth, deleteRagEvalCase);

export default router;

import { Request, Response } from 'express';
import { metrics } from '../lib/metrics';
import { ragEvalQueue } from '../services/ragEvalQueue';
import { toSafeError } from '../lib/safeError';
import {
  cancelRagEvalRunForUser,
  createRagEvalCaseForUser,
  createRagEvalDatasetForUser,
  createRunningRagEvalRunForUser,
  deleteRagEvalCaseForUser,
  deleteRagEvalDatasetForUser,
  getRagEvalDatasetWithCasesForUser,
  getRagEvalQualitySummaryForUser,
  getRagEvalRunForUser,
  listHistoricalRagRunsForUser,
  listRagEvalDatasetsForUser,
  updateRagEvalDatasetForUser,
} from '../repositories/ragEval';

const MAX_RAG_EVAL_CASES_PER_RUN = 50;
const MAX_RAG_EVAL_CASES_PER_DATASET = 50;
const DEFAULT_RAG_EVAL_HISTORY_LIMIT = 50;
const MAX_RAG_EVAL_HISTORY_LIMIT = 200;

const parseBoundedLimit = (value: unknown, defaultValue: number, maxValue: number) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !raw.trim()) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultValue;

  return Math.min(parsed, maxValue);
};

const readProjectSpaceId = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || null;
};

export const listRagEvalDatasets = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const datasets = await listRagEvalDatasetsForUser(req.user.id);
    res.json(datasets);
  } catch (error) {
    console.error('Error listing RAG eval datasets:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to list RAG eval datasets' });
  }
};

export const listRagEvalHistory = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const historyLimit = parseBoundedLimit(
    req.query.limit,
    DEFAULT_RAG_EVAL_HISTORY_LIMIT,
    MAX_RAG_EVAL_HISTORY_LIMIT
  );

  try {
    const history = await listHistoricalRagRunsForUser(req.user.id, historyLimit);
    res.json({ items: history });
  } catch (error) {
    console.error('Error listing historical RAG runs:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to list historical RAG runs' });
  }
};

export const createRagEvalDataset = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const name = req.body.name as string;
  const description = (req.body.description ?? '') as string;

  try {
    const dataset = await createRagEvalDatasetForUser({
      userId: req.user.id,
      projectSpaceId: readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId),
      name,
      description,
    });
    res.status(201).json(dataset);
  } catch (error) {
    console.error('Error creating RAG eval dataset:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to create RAG eval dataset' });
  }
};

export const updateRagEvalDataset = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const name = req.body.name as string;
  const description = (req.body.description ?? '') as string;

  try {
    const dataset = await updateRagEvalDatasetForUser({
      userId: req.user.id,
      datasetId: req.params.datasetId,
      projectSpaceId: readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId),
      name,
      description,
    });
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    res.json(dataset);
  } catch (error) {
    console.error('Error updating RAG eval dataset:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to update RAG eval dataset' });
  }
};

export const deleteRagEvalDataset = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const deleted = await deleteRagEvalDatasetForUser(req.params.datasetId, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Dataset not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting RAG eval dataset:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to delete RAG eval dataset' });
  }
};

export const createRagEvalCase = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { datasetId } = req.params;
  const question = req.body.question as string;

  try {
    const dataset = await getRagEvalDatasetWithCasesForUser(datasetId, req.user.id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    if (dataset.cases.length >= MAX_RAG_EVAL_CASES_PER_DATASET) {
      return res.status(400).json({ error: 'Dataset has too many eval cases' });
    }

    const testCase = await createRagEvalCaseForUser({
      userId: req.user.id,
      datasetId,
      question,
      expectedAnswer: req.body.expected_answer ?? req.body.expectedAnswer ?? '',
      expectedKeywords: req.body.expected_keywords ?? req.body.expectedKeywords ?? [],
      expectedSourceFiles: req.body.expected_source_files ?? req.body.expectedSourceFiles ?? [],
      maxCases: MAX_RAG_EVAL_CASES_PER_DATASET,
    });

    if (!testCase) return res.status(400).json({ error: 'Dataset has too many eval cases' });
    res.status(201).json(testCase);
  } catch (error) {
    console.error('Error creating RAG eval case:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to create RAG eval case' });
  }
};

export const deleteRagEvalCase = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const deleted = await deleteRagEvalCaseForUser(req.params.caseId, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Eval case not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting RAG eval case:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to delete RAG eval case' });
  }
};

export const getRagEvalRun = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const run = await getRagEvalRunForUser(req.params.runId, req.user.id);
    if (!run) return res.status(404).json({ error: 'Eval run not found' });
    res.json(run);
  } catch (error) {
    console.error('Error loading RAG eval run:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to load RAG eval run' });
  }
};

export const getRagEvalQualitySummary = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const summary = await getRagEvalQualitySummaryForUser(req.params.datasetId, req.user.id);
    if (!summary) return res.status(404).json({ error: 'Dataset not found' });
    res.json(summary);
  } catch (error) {
    console.error('Error loading RAG eval quality summary:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to load RAG eval quality summary' });
  }
};

export const runRagEvalDataset = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const dataset = await getRagEvalDatasetWithCasesForUser(req.params.datasetId, req.user.id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    if (!dataset.cases || dataset.cases.length === 0) {
      return res.status(400).json({ error: 'Dataset has no eval cases' });
    }
    if (dataset.cases.length > MAX_RAG_EVAL_CASES_PER_RUN) {
      return res.status(400).json({ error: 'Dataset has too many eval cases for one run' });
    }

    const run = await createRunningRagEvalRunForUser({
      userId: req.user.id,
      datasetId: dataset.id,
      caseCount: dataset.cases.length,
    });

    if (run.created) {
      metrics.recordRagEvalRunStarted();
      ragEvalQueue.trigger();
    } else {
      metrics.recordRagEvalRunReused();
    }

    res.status(202).json(run);
  } catch (error) {
    console.error('Error running RAG eval dataset:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to run RAG eval dataset' });
  }
};

export const cancelRagEvalRun = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const run = await cancelRagEvalRunForUser(req.params.runId, req.user.id);
    if (!run) return res.status(404).json({ error: 'Running eval run not found' });

    ragEvalQueue.abortRun(run.id);
    metrics.recordRagEvalRunCompleted('cancelled');
    res.json(run);
  } catch (error) {
    console.error('Error cancelling RAG eval run:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to cancel RAG eval run' });
  }
};

import { Request, Response } from 'express';
import { metrics } from '../lib/metrics';
import { ragEvalQueue } from '../services/ragEvalQueue';
import {
  cancelRagEvalRunForUser,
  createRagEvalCaseForUser,
  createRagEvalDatasetForUser,
  createRunningRagEvalRunForUser,
  deleteRagEvalCaseForUser,
  deleteRagEvalDatasetForUser,
  getRagEvalDatasetWithCasesForUser,
  getRagEvalRunForUser,
  listRagEvalDatasetsForUser,
  updateRagEvalDatasetForUser,
} from '../repositories/ragEval';

const MAX_RAG_EVAL_CASES_PER_RUN = 50;
const MAX_RAG_EVAL_CASES_PER_DATASET = 50;

const cleanText = (value: unknown, maxLength: number) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

const cleanStringList = (value: unknown, maxItems = 20, maxLength = 120) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
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
    console.error('Error listing RAG eval datasets:', error);
    res.status(500).json({ error: 'Failed to list RAG eval datasets' });
  }
};

export const createRagEvalDataset = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const name = cleanText(req.body.name, 120);
  const description = cleanText(req.body.description, 500);
  if (!name) return res.status(400).json({ error: 'Dataset name is required' });

  try {
    const dataset = await createRagEvalDatasetForUser({
      userId: req.user.id,
      projectSpaceId: readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId),
      name,
      description,
    });
    res.status(201).json(dataset);
  } catch (error) {
    console.error('Error creating RAG eval dataset:', error);
    res.status(500).json({ error: 'Failed to create RAG eval dataset' });
  }
};

export const updateRagEvalDataset = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const name = cleanText(req.body.name, 120);
  const description = cleanText(req.body.description, 500);
  if (!name) return res.status(400).json({ error: 'Dataset name is required' });

  try {
    const dataset = await updateRagEvalDatasetForUser({
      userId: req.user.id,
      datasetId: req.params.datasetId,
      projectSpaceId: readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId),
      name,
      description,
    });
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    res.json(dataset);
  } catch (error) {
    console.error('Error updating RAG eval dataset:', error);
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
    console.error('Error deleting RAG eval dataset:', error);
    res.status(500).json({ error: 'Failed to delete RAG eval dataset' });
  }
};

export const createRagEvalCase = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { datasetId } = req.params;
  const question = cleanText(req.body.question, 4096);
  if (!question) return res.status(400).json({ error: 'Question is required' });

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
      expectedAnswer: cleanText(req.body.expected_answer || req.body.expectedAnswer, 4000),
      expectedKeywords: cleanStringList(req.body.expected_keywords || req.body.expectedKeywords),
      expectedSourceFiles: cleanStringList(req.body.expected_source_files || req.body.expectedSourceFiles),
      maxCases: MAX_RAG_EVAL_CASES_PER_DATASET,
    });

    if (!testCase) return res.status(400).json({ error: 'Dataset has too many eval cases' });
    res.status(201).json(testCase);
  } catch (error) {
    console.error('Error creating RAG eval case:', error);
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
    console.error('Error deleting RAG eval case:', error);
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
    console.error('Error loading RAG eval run:', error);
    res.status(500).json({ error: 'Failed to load RAG eval run' });
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
    console.error('Error running RAG eval dataset:', error);
    res.status(500).json({ error: 'Failed to run RAG eval dataset' });
  }
};

export const cancelRagEvalRun = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const run = await cancelRagEvalRunForUser(req.params.runId, req.user.id);
    if (!run) return res.status(404).json({ error: 'Running eval run not found' });

    metrics.recordRagEvalRunCompleted('cancelled');
    res.json(run);
  } catch (error) {
    console.error('Error cancelling RAG eval run:', error);
    res.status(500).json({ error: 'Failed to cancel RAG eval run' });
  }
};

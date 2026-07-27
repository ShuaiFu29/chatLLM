import { AppReply, AppRequest } from '../common/http/app-request';
import { serverEnv } from '../lib/env';
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

const MAX_RAG_EVAL_CASES_PER_RUN = serverEnv.RAG_EVAL_MAX_CASES_PER_RUN;
const MAX_RAG_EVAL_CASES_PER_DATASET = serverEnv.RAG_EVAL_MAX_CASES_PER_DATASET;
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

export const listRagEvalDatasets = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const datasets = await listRagEvalDatasetsForUser(req.user.id);
    res.send(datasets);
  } catch (error) {
    console.error('Error listing RAG eval datasets:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to list RAG eval datasets' });
  }
};

export const listRagEvalHistory = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const historyLimit = parseBoundedLimit(
    req.query.limit,
    DEFAULT_RAG_EVAL_HISTORY_LIMIT,
    MAX_RAG_EVAL_HISTORY_LIMIT
  );

  try {
    const history = await listHistoricalRagRunsForUser(req.user.id, historyLimit);
    res.send({ items: history });
  } catch (error) {
    console.error('Error listing historical RAG runs:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to list historical RAG runs' });
  }
};

export const createRagEvalDataset = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  const name = req.body.name as string;
  const description = (req.body.description ?? '') as string;

  try {
    const dataset = await createRagEvalDatasetForUser({
      userId: req.user.id,
      projectSpaceId: readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId),
      name,
      description,
    });
    res.code(201).send(dataset);
  } catch (error) {
    console.error('Error creating RAG eval dataset:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to create RAG eval dataset' });
  }
};

export const updateRagEvalDataset = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

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
    if (!dataset) return res.code(404).send({ error: 'Dataset not found' });
    res.send(dataset);
  } catch (error) {
    console.error('Error updating RAG eval dataset:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to update RAG eval dataset' });
  }
};

export const deleteRagEvalDataset = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const deleted = await deleteRagEvalDatasetForUser(req.params.datasetId, req.user.id);
    if (!deleted) return res.code(404).send({ error: 'Dataset not found' });
    res.send({ success: true });
  } catch (error) {
    console.error('Error deleting RAG eval dataset:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to delete RAG eval dataset' });
  }
};

export const createRagEvalCase = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  const { datasetId } = req.params;
  const question = req.body.question as string;

  try {
    const dataset = await getRagEvalDatasetWithCasesForUser(datasetId, req.user.id);
    if (!dataset) return res.code(404).send({ error: 'Dataset not found' });
    if (dataset.cases.length >= MAX_RAG_EVAL_CASES_PER_DATASET) {
      return res.code(400).send({ error: 'Dataset has too many eval cases' });
    }

    const testCase = await createRagEvalCaseForUser({
      userId: req.user.id,
      datasetId,
      question,
      expectedAnswer: req.body.expected_answer ?? req.body.expectedAnswer ?? '',
      expectedKeywords: req.body.expected_keywords ?? req.body.expectedKeywords ?? [],
      expectedSourceFiles: req.body.expected_source_files ?? req.body.expectedSourceFiles ?? [],
      evaluationSpec: req.body.evaluation_spec ?? req.body.evaluationSpec ?? {},
      maxCases: MAX_RAG_EVAL_CASES_PER_DATASET,
    });

    if (!testCase) return res.code(400).send({ error: 'Dataset has too many eval cases' });
    res.code(201).send(testCase);
  } catch (error) {
    console.error('Error creating RAG eval case:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to create RAG eval case' });
  }
};

export const deleteRagEvalCase = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const deleted = await deleteRagEvalCaseForUser(req.params.caseId, req.user.id);
    if (!deleted) return res.code(404).send({ error: 'Eval case not found' });
    res.send({ success: true });
  } catch (error) {
    console.error('Error deleting RAG eval case:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to delete RAG eval case' });
  }
};

export const getRagEvalRun = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const run = await getRagEvalRunForUser(req.params.runId, req.user.id);
    if (!run) return res.code(404).send({ error: 'Eval run not found' });
    res.send(run);
  } catch (error) {
    console.error('Error loading RAG eval run:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to load RAG eval run' });
  }
};

export const getRagEvalQualitySummary = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const summary = await getRagEvalQualitySummaryForUser(req.params.datasetId, req.user.id);
    if (!summary) return res.code(404).send({ error: 'Dataset not found' });
    res.send(summary);
  } catch (error) {
    console.error('Error loading RAG eval quality summary:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to load RAG eval quality summary' });
  }
};

export const runRagEvalDataset = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const dataset = await getRagEvalDatasetWithCasesForUser(req.params.datasetId, req.user.id);
    if (!dataset) return res.code(404).send({ error: 'Dataset not found' });
    if (!dataset.cases || dataset.cases.length === 0) {
      return res.code(400).send({ error: 'Dataset has no eval cases' });
    }
    if (dataset.cases.length > MAX_RAG_EVAL_CASES_PER_RUN) {
      return res.code(400).send({ error: 'Dataset has too many eval cases for one run' });
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

    res.code(202).send(run);
  } catch (error) {
    console.error('Error running RAG eval dataset:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to run RAG eval dataset' });
  }
};

export const cancelRagEvalRun = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const run = await cancelRagEvalRunForUser(req.params.runId, req.user.id);
    if (!run) return res.code(404).send({ error: 'Running eval run not found' });

    ragEvalQueue.abortRun(run.id);
    metrics.recordRagEvalRunCompleted('cancelled');
    res.send(run);
  } catch (error) {
    console.error('Error cancelling RAG eval run:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to cancel RAG eval run' });
  }
};

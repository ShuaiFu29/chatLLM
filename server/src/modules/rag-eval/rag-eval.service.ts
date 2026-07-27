import { HttpException, Injectable } from '@nestjs/common';
import { serverEnv } from '../../lib/env';
import { metrics } from '../../lib/metrics';
import { toSafeError } from '../../lib/safeError';
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
  RagEvalEvaluationSpec,
  updateRagEvalDatasetForUser,
} from '../../repositories/ragEval';
import { ragEvalQueue } from '../../services/ragEvalQueue';

export interface RagEvalDatasetBody {
  name: string;
  description?: string;
  project_space_id?: string;
  projectSpaceId?: string;
}

export interface RagEvalCaseBody {
  question: string;
  expected_answer?: string;
  expectedAnswer?: string;
  expected_keywords?: string[];
  expectedKeywords?: string[];
  expected_source_files?: string[];
  expectedSourceFiles?: string[];
  evaluation_spec?: RagEvalEvaluationSpec;
  evaluationSpec?: RagEvalEvaluationSpec;
}

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

const requestError = (status: number, error: string) => (
  new HttpException({ error }, status)
);

@Injectable()
export class RagEvalService {
  async listDatasets(userId: string, requestId?: string) {
    try {
      return await listRagEvalDatasetsForUser(userId);
    } catch (error) {
      console.error('Error listing RAG eval datasets:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to list RAG eval datasets');
    }
  }

  async history(userId: string, limit: unknown, requestId?: string) {
    const historyLimit = parseBoundedLimit(
      limit,
      DEFAULT_RAG_EVAL_HISTORY_LIMIT,
      MAX_RAG_EVAL_HISTORY_LIMIT,
    );

    try {
      const history = await listHistoricalRagRunsForUser(userId, historyLimit);
      return { items: history };
    } catch (error) {
      console.error('Error listing historical RAG runs:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to list historical RAG runs');
    }
  }

  async createDataset(userId: string, body: RagEvalDatasetBody, requestId?: string) {
    try {
      return await createRagEvalDatasetForUser({
        userId,
        projectSpaceId: readProjectSpaceId(
          body.project_space_id ?? body.projectSpaceId,
        ),
        name: body.name,
        description: body.description ?? '',
      });
    } catch (error) {
      console.error('Error creating RAG eval dataset:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to create RAG eval dataset');
    }
  }

  async updateDataset(
    userId: string,
    datasetId: string,
    body: RagEvalDatasetBody,
    requestId?: string,
  ) {
    try {
      const dataset = await updateRagEvalDatasetForUser({
        userId,
        datasetId,
        projectSpaceId: readProjectSpaceId(
          body.project_space_id ?? body.projectSpaceId,
        ),
        name: body.name,
        description: body.description ?? '',
      });
      if (!dataset) throw requestError(404, 'Dataset not found');
      return dataset;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error updating RAG eval dataset:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to update RAG eval dataset');
    }
  }

  async deleteDataset(userId: string, datasetId: string, requestId?: string) {
    try {
      const deleted = await deleteRagEvalDatasetForUser(datasetId, userId);
      if (!deleted) throw requestError(404, 'Dataset not found');
      return { success: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error deleting RAG eval dataset:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to delete RAG eval dataset');
    }
  }

  async createCase(
    userId: string,
    datasetId: string,
    body: RagEvalCaseBody,
    requestId?: string,
  ) {
    try {
      const dataset = await getRagEvalDatasetWithCasesForUser(datasetId, userId);
      if (!dataset) throw requestError(404, 'Dataset not found');
      if (dataset.cases.length >= MAX_RAG_EVAL_CASES_PER_DATASET) {
        throw requestError(400, 'Dataset has too many eval cases');
      }

      const testCase = await createRagEvalCaseForUser({
        userId,
        datasetId,
        question: body.question,
        expectedAnswer: body.expected_answer ?? body.expectedAnswer ?? '',
        expectedKeywords: body.expected_keywords ?? body.expectedKeywords ?? [],
        expectedSourceFiles: body.expected_source_files ?? body.expectedSourceFiles ?? [],
        evaluationSpec: body.evaluation_spec ?? body.evaluationSpec ?? {},
        maxCases: MAX_RAG_EVAL_CASES_PER_DATASET,
      });

      if (!testCase) throw requestError(400, 'Dataset has too many eval cases');
      return testCase;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error creating RAG eval case:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to create RAG eval case');
    }
  }

  async deleteCase(userId: string, caseId: string, requestId?: string) {
    try {
      const deleted = await deleteRagEvalCaseForUser(caseId, userId);
      if (!deleted) throw requestError(404, 'Eval case not found');
      return { success: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error deleting RAG eval case:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to delete RAG eval case');
    }
  }

  async getRun(userId: string, runId: string, requestId?: string) {
    try {
      const run = await getRagEvalRunForUser(runId, userId);
      if (!run) throw requestError(404, 'Eval run not found');
      return run;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error loading RAG eval run:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to load RAG eval run');
    }
  }

  async qualitySummary(userId: string, datasetId: string, requestId?: string) {
    try {
      const summary = await getRagEvalQualitySummaryForUser(datasetId, userId);
      if (!summary) throw requestError(404, 'Dataset not found');
      return summary;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error loading RAG eval quality summary:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to load RAG eval quality summary');
    }
  }

  async runDataset(userId: string, datasetId: string, requestId?: string) {
    try {
      const dataset = await getRagEvalDatasetWithCasesForUser(datasetId, userId);
      if (!dataset) throw requestError(404, 'Dataset not found');
      if (!dataset.cases || dataset.cases.length === 0) {
        throw requestError(400, 'Dataset has no eval cases');
      }
      if (dataset.cases.length > MAX_RAG_EVAL_CASES_PER_RUN) {
        throw requestError(400, 'Dataset has too many eval cases for one run');
      }

      const run = await createRunningRagEvalRunForUser({
        userId,
        datasetId: dataset.id,
        caseCount: dataset.cases.length,
      });

      if (run.created) {
        metrics.recordRagEvalRunStarted();
        ragEvalQueue.trigger();
      } else {
        metrics.recordRagEvalRunReused();
      }
      return run;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error running RAG eval dataset:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to run RAG eval dataset');
    }
  }

  async cancelRun(userId: string, runId: string, requestId?: string) {
    try {
      const run = await cancelRagEvalRunForUser(runId, userId);
      if (!run) throw requestError(404, 'Running eval run not found');

      ragEvalQueue.abortRun(run.id);
      metrics.recordRagEvalRunCompleted('cancelled');
      return run;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error cancelling RAG eval run:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to cancel RAG eval run');
    }
  }
}

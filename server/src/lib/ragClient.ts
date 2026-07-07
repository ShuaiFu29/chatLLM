import axios from 'axios';
import { RagDocument, RagQualitySummary, RagTraceStep } from './chatSources';
import { serverEnv } from './env';
import { metrics } from './metrics';

interface RetrieveRagDocumentsInput {
  query: string;
  user_id: string;
  project_space_id?: string;
  limit: number;
  threshold: number;
}

interface ListRagGraphDocumentsInput {
  user_id: string;
  project_space_id?: string;
  limit: number;
}

export interface AgenticRagResponse {
  run_id: string;
  mode: string;
  intent?: {
    type: string;
    complexity: string;
    routes: string[];
  };
  planned_queries: string[];
  results: RagDocument[];
  trace_steps: RagTraceStep[];
  quality: RagQualitySummary;
  inventory_total?: number;
  inventory_limit?: number;
  insufficient_evidence?: boolean;
  answer_guidance?: string;
}

export interface RagEvalCaseInput {
  id: string;
  question: string;
  expected_answer?: string;
  expected_keywords?: string[];
  expected_source_files?: string[];
}

export interface RagEvalRunResponse {
  case_count: number;
  failed_count: number;
  duration_ms: number;
  average_overall_score: number;
  average_retrieval_score: number;
  average_answer_score: number;
  average_source_score: number;
  average_source_recall_score?: number;
  average_source_precision_score?: number;
  average_citation_accuracy_score?: number;
  average_keyword_score: number;
  average_answer_keyword_score?: number;
  average_grounding_score?: number;
  average_judge_score?: number;
  results: Array<{
    case_id: string;
    question: string;
    status: 'success' | 'failed';
    overall_score: number;
    retrieval_score: number;
    answer_score: number;
    source_score: number;
    source_recall_score?: number;
    source_precision_score?: number;
    citation_accuracy_score?: number;
    keyword_score: number;
    answer_keyword_score?: number;
    grounding_score?: number;
    judge_score?: number;
    latency_ms?: number;
    evidence_label: string;
    matched_sources: unknown[];
    trace_summary: Record<string, unknown>;
    error_message: string;
  }>;
}

let consecutiveFailures = 0;
let circuitOpenedAt = 0;

const isCircuitOpen = () => {
  if (circuitOpenedAt === 0) return false;

  const elapsedMs = Date.now() - circuitOpenedAt;
  if (elapsedMs >= serverEnv.RAG_CIRCUIT_RESET_MS) {
    circuitOpenedAt = 0;
    consecutiveFailures = 0;
    return false;
  }

  return true;
};

export const buildRagServiceHeaders = () => {
  if (!serverEnv.RAG_SERVICE_TOKEN) return {};
  return { 'X-ChatLLM-RAG-Token': serverEnv.RAG_SERVICE_TOKEN };
};

const postRagService = async <T>(path: string, payload: unknown, timeout: number): Promise<T> => {
  if (isCircuitOpen()) {
    metrics.recordRagCircuitOpen();
    throw new Error('RAG circuit is open');
  }

  const startedAt = Date.now();

  try {
    const response = await axios.post(`${serverEnv.RAG_SERVICE_URL}${path}`, payload, {
      timeout,
      headers: buildRagServiceHeaders(),
    });

    consecutiveFailures = 0;
    circuitOpenedAt = 0;
    metrics.recordRagRetrieve('ok', Date.now() - startedAt);

    return response.data as T;
  } catch (error) {
    consecutiveFailures += 1;
    metrics.recordRagRetrieve('error', Date.now() - startedAt);

    if (consecutiveFailures >= serverEnv.RAG_CIRCUIT_FAILURE_THRESHOLD) {
      circuitOpenedAt = Date.now();
    }

    throw error;
  }
};

export const retrieveRagDocuments = async (input: RetrieveRagDocumentsInput): Promise<RagDocument[]> => {
  const response = await postRagService<{ results?: RagDocument[] }>(
    '/retrieve',
    input,
    serverEnv.RAG_RETRIEVE_TIMEOUT_MS
  );

  return response.results || [];
};

export const retrieveAgenticRagDocuments = async (input: RetrieveRagDocumentsInput): Promise<AgenticRagResponse> => {
  return postRagService<AgenticRagResponse>('/agentic-retrieve', input, serverEnv.RAG_RETRIEVE_TIMEOUT_MS);
};

export const searchRagGraphDocuments = async (input: RetrieveRagDocumentsInput): Promise<RagDocument[]> => {
  const response = await postRagService<{ results?: RagDocument[] }>(
    '/graph/search',
    input,
    serverEnv.RAG_RETRIEVE_TIMEOUT_MS
  );

  return response.results || [];
};

export const listRagGraphDocuments = async (input: ListRagGraphDocumentsInput): Promise<RagDocument[]> => {
  const response = await postRagService<{ results?: RagDocument[] }>(
    '/graph/list',
    input,
    serverEnv.RAG_RETRIEVE_TIMEOUT_MS
  );

  return response.results || [];
};

export const runRagEvaluation = async (input: {
  user_id: string;
  project_space_id?: string | null;
  cases: RagEvalCaseInput[];
  limit?: number;
  threshold?: number;
}): Promise<RagEvalRunResponse> => {
  return postRagService<RagEvalRunResponse>(
    '/eval/run',
    {
      user_id: input.user_id,
      project_space_id: input.project_space_id || undefined,
      cases: input.cases,
      limit: input.limit || 10,
      threshold: input.threshold ?? 0.1,
    },
    Math.max(serverEnv.RAG_RETRIEVE_TIMEOUT_MS, 30000)
  );
};

export const cleanupRagFileVectors = async (fileId: string) => {
  await axios.post(`${serverEnv.RAG_SERVICE_URL}/cleanup-file`, {
    file_id: fileId,
  }, {
    timeout: serverEnv.RAG_CLEANUP_TIMEOUT_MS,
    headers: buildRagServiceHeaders(),
  });
};

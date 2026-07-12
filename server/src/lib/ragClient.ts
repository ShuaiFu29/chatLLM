import axios, { AxiosRequestConfig } from 'axios';
import { RagDocument, RagQualitySummary, RagTraceStep } from './chatSources';
import { CircuitOpenError, OperationCircuitBreaker } from './circuitBreaker';
import { serverEnv } from './env';
import { metrics as defaultMetrics } from './metrics';

interface RetrieveRagDocumentsInput {
  query: string;
  user_id: string;
  project_space_id?: string;
  conversation_id?: string;
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
  cache?: {
    status: 'disabled' | 'hit' | 'miss' | 'partial' | string;
    hit_type?: string;
    scope_fingerprint?: string;
    reused_count?: number;
  };
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
  average_expected_answer_support_score?: number;
  average_verification_score?: number;
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
    expected_answer_support_score?: number;
    expected_answer_support_label?: string;
    verification_score?: number;
    latency_ms?: number;
    evidence_label: string;
    support_label?: string;
    risk_level?: string;
    matched_sources: unknown[];
    trace_summary: Record<string, unknown>;
    error_message: string;
  }>;
}

export type RagOperation = 'retrieve' | 'agentic-retrieve' | 'graph' | 'eval' | 'ingest' | 'cleanup' | 'health';

export interface IngestRagFileInput {
  fileId: string;
  attemptId: string;
  leaseToken: string;
}

interface RagTransportResponse<T> {
  data: T;
  status: number;
}

export interface RagTransport {
  get<T>(url: string, config: AxiosRequestConfig): Promise<RagTransportResponse<T>>;
  post<T>(url: string, data: unknown, config: AxiosRequestConfig): Promise<RagTransportResponse<T>>;
}

interface RagClientMetrics {
  recordRagRetrieve(status: 'ok' | 'error', durationMs: number): void;
  recordRagCircuitOpen(): void;
}

export interface CreateRagClientOptions {
  transport?: RagTransport;
  metrics?: RagClientMetrics;
  now?: () => number;
  serviceUrl?: string;
  serviceToken?: string;
  retrieveTimeoutMs?: number;
  ingestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  healthTimeoutMs?: number;
  failureThreshold?: number;
  resetMs?: number;
}

const axiosTransport: RagTransport = {
  get: <T>(url: string, config: AxiosRequestConfig) => axios.get<T>(url, config),
  post: <T>(url: string, data: unknown, config: AxiosRequestConfig) => axios.post<T>(url, data, config),
};

export const isRagServiceFailure = (error: unknown) => {
  if (axios.isCancel(error)) return false;
  if (!axios.isAxiosError(error)) return true;
  if (!error.response) return true;
  return error.response.status === 429 || error.response.status >= 500;
};

const buildHeaders = (token: string): Record<string, string> => (
  token ? { 'X-ChatLLM-RAG-Token': token } : {}
);

export const buildRagServiceHeaders = () => buildHeaders(serverEnv.RAG_SERVICE_TOKEN);

export const createRagClient = (options: CreateRagClientOptions = {}) => {
  const transport = options.transport || axiosTransport;
  const clientMetrics = options.metrics || defaultMetrics;
  const now = options.now || Date.now;
  const serviceUrl = (options.serviceUrl || serverEnv.RAG_SERVICE_URL).replace(/\/+$/, '');
  const serviceToken = options.serviceToken ?? serverEnv.RAG_SERVICE_TOKEN;
  const retrieveTimeoutMs = options.retrieveTimeoutMs ?? serverEnv.RAG_RETRIEVE_TIMEOUT_MS;
  const ingestTimeoutMs = options.ingestTimeoutMs ?? serverEnv.FILE_QUEUE_INGEST_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? serverEnv.RAG_CLEANUP_TIMEOUT_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? serverEnv.RAG_HEALTH_TIMEOUT_MS;
  const breaker = new OperationCircuitBreaker<RagOperation>({
    failureThreshold: options.failureThreshold ?? serverEnv.RAG_CIRCUIT_FAILURE_THRESHOLD,
    resetMs: options.resetMs ?? serverEnv.RAG_CIRCUIT_RESET_MS,
    now,
    isServiceFailure: isRagServiceFailure,
  });

  const requestRagService = async <T>(
    operation: RagOperation,
    request: () => Promise<RagTransportResponse<T>>,
  ): Promise<T> => {
    let permit;
    try {
      permit = breaker.acquire(operation);
    } catch (error) {
      if (error instanceof CircuitOpenError) clientMetrics.recordRagCircuitOpen();
      throw error;
    }

    const startedAt = now();
    try {
      const response = await request();
      breaker.recordSuccess(operation);
      clientMetrics.recordRagRetrieve('ok', now() - startedAt);
      return response.data;
    } catch (error) {
      breaker.recordFailure(operation, permit, error);
      clientMetrics.recordRagRetrieve('error', now() - startedAt);
      throw error;
    }
  };

  const postRagService = <T>(
    operation: RagOperation,
    path: string,
    payload: unknown,
    timeout: number,
    signal?: AbortSignal,
  ) => requestRagService<T>(operation, () => transport.post<T>(
    `${serviceUrl}${path}`,
    payload,
    {
      timeout,
      headers: buildHeaders(serviceToken),
      ...(signal ? { signal } : {}),
    },
  ));

  const retrieveRagDocuments = async (input: RetrieveRagDocumentsInput): Promise<RagDocument[]> => {
    const response = await postRagService<{ results?: RagDocument[] }>(
      'retrieve',
      '/retrieve',
      input,
      retrieveTimeoutMs,
    );
    return response.results || [];
  };

  const retrieveAgenticRagDocuments = (input: RetrieveRagDocumentsInput): Promise<AgenticRagResponse> => (
    postRagService<AgenticRagResponse>(
      'agentic-retrieve',
      '/agentic-retrieve',
      input,
      retrieveTimeoutMs,
    )
  );

  const searchRagGraphDocuments = async (input: RetrieveRagDocumentsInput): Promise<RagDocument[]> => {
    const response = await postRagService<{ results?: RagDocument[] }>(
      'graph',
      '/graph/search',
      input,
      retrieveTimeoutMs,
    );
    return response.results || [];
  };

  const listRagGraphDocuments = async (input: ListRagGraphDocumentsInput): Promise<RagDocument[]> => {
    const response = await postRagService<{ results?: RagDocument[] }>(
      'graph',
      '/graph/list',
      input,
      retrieveTimeoutMs,
    );
    return response.results || [];
  };

  const runRagEvaluation = (input: {
    user_id: string;
    project_space_id?: string | null;
    cases: RagEvalCaseInput[];
    limit?: number;
    threshold?: number;
  }): Promise<RagEvalRunResponse> => postRagService<RagEvalRunResponse>(
    'eval',
    '/eval/run',
    {
      user_id: input.user_id,
      project_space_id: input.project_space_id || undefined,
      cases: input.cases,
      limit: input.limit || 10,
      threshold: input.threshold ?? 0.1,
    },
    Math.max(retrieveTimeoutMs, 30000),
  );

  const ingestRagFile = (
    input: IngestRagFileInput,
    signal?: AbortSignal,
  ): Promise<unknown> => postRagService<unknown>(
    'ingest',
    '/ingest-sync',
    {
      file_id: input.fileId,
      attempt_id: input.attemptId,
      lease_token: input.leaseToken,
    },
    ingestTimeoutMs,
    signal,
  );

  const cleanupRagFileVectors = async (fileId: string) => {
    await postRagService<unknown>(
      'cleanup',
      '/cleanup-file',
      { file_id: fileId },
      cleanupTimeoutMs,
    );
  };

  const checkRagServiceReady = async () => {
    await requestRagService<unknown>('health', () => transport.get<unknown>(
      `${serviceUrl}/health/ready`,
      { timeout: healthTimeoutMs, headers: buildHeaders(serviceToken) },
    ));
  };

  return {
    retrieveRagDocuments,
    retrieveAgenticRagDocuments,
    searchRagGraphDocuments,
    listRagGraphDocuments,
    runRagEvaluation,
    ingestRagFile,
    cleanupRagFileVectors,
    checkRagServiceReady,
  };
};

const ragClient = createRagClient();

export const retrieveRagDocuments = ragClient.retrieveRagDocuments;
export const retrieveAgenticRagDocuments = ragClient.retrieveAgenticRagDocuments;
export const searchRagGraphDocuments = ragClient.searchRagGraphDocuments;
export const listRagGraphDocuments = ragClient.listRagGraphDocuments;
export const runRagEvaluation = ragClient.runRagEvaluation;
export const ingestRagFile = ragClient.ingestRagFile;
export const cleanupRagFileVectors = ragClient.cleanupRagFileVectors;
export const checkRagServiceReady = ragClient.checkRagServiceReady;

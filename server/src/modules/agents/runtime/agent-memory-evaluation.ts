import { performance } from 'node:perf_hooks';
import type {
  AgentMemoryGoldDataset,
  AgentMemoryGoldMemory,
} from '../../../evals/agent-memory-zh-cn-v1';
import type { AgentMemoryRow } from '../../../repositories/agentMemories';
import { retrieveAgentMemories } from './agent-memory-retrieval';

export const AGENT_MEMORY_EVALUATOR_VERSION = 'agent-memory-retrieval-eval-v1';

export interface AgentMemoryEvaluationThresholds {
  recallAtK: number;
  meanReciprocalRank: number;
  irrelevantInjectionRate: number;
  noRelevantSafeRate: number;
  p95RankLatencyMs: number;
}

export const DEFAULT_AGENT_MEMORY_EVALUATION_THRESHOLDS: AgentMemoryEvaluationThresholds = {
  recallAtK: 0.9,
  meanReciprocalRank: 0.9,
  irrelevantInjectionRate: 0.08,
  noRelevantSafeRate: 1,
  p95RankLatencyMs: 25,
};

export interface AgentMemoryEvaluationCaseResult {
  caseId: string;
  relevantMemoryIds: string[];
  retrievedMemoryIds: string[];
  recallAtK: number | null;
  reciprocalRank: number | null;
  irrelevantRetrievedCount: number;
  rankingMode: string;
}

export interface AgentMemoryEvaluationReport {
  evaluatorVersion: string;
  datasetId: string;
  datasetFormatVersion: number;
  annotationPolicy: string;
  topK: number;
  caseCount: number;
  positiveCaseCount: number;
  noRelevantCaseCount: number;
  candidateJudgementCount: number;
  recallAtK: number;
  meanReciprocalRank: number;
  irrelevantInjectionRate: number;
  noRelevantSafeRate: number;
  p95RankLatencyMs: number;
  latencyScope: 'in_process_ranker_only';
  thresholds: AgentMemoryEvaluationThresholds;
  passed: boolean;
  failures: string[];
  cases: AgentMemoryEvaluationCaseResult[];
}

const mean = (values: readonly number[]) => (
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
);

const percentile = (values: readonly number[], quantile: number) => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[Math.min(index, ordered.length - 1)];
};

const toMemoryRow = (item: AgentMemoryGoldMemory): AgentMemoryRow => ({
  id: item.id,
  user_id: '00000000-0000-4000-8000-000000000001',
  scope: 'user',
  scope_ref_id: null,
  kind: item.kind,
  content: item.content,
  provenance_run_id: null,
  provenance_step_id: null,
  source_trust: item.sourceTrust,
  status: 'confirmed',
  verification_status: item.sourceTrust === 'user_stated'
    ? 'user_confirmed'
    : 'policy_confirmed',
  verified_at: item.createdAt,
  confidence: item.confidence,
  sensitivity: 'normal',
  last_recalled_at: null,
  recall_count: 0,
  superseded_by: null,
  deleted_at: null,
  expires_at: null,
  embedding: null,
  embedding_model: null,
  created_at: item.createdAt,
  updated_at: item.createdAt,
});

const assertDataset = (dataset: AgentMemoryGoldDataset) => {
  if (dataset.formatVersion !== 1 || dataset.annotationPolicy !== 'exhaustive_against_complete_pool') {
    throw new Error('Unsupported Agent Memory evaluation dataset');
  }
  if (dataset.memories.length === 0 || dataset.cases.length === 0) {
    throw new Error('Agent Memory evaluation dataset must not be empty');
  }
  const memoryIds = new Set<string>();
  for (const item of dataset.memories) {
    if (!item.id || memoryIds.has(item.id)) throw new Error('Agent Memory ids must be unique');
    if (!item.content.trim()) throw new Error('Agent Memory content must not be empty');
    memoryIds.add(item.id);
  }
  const caseIds = new Set<string>();
  for (const item of dataset.cases) {
    if (!item.id || caseIds.has(item.id)) throw new Error('Agent Memory case ids must be unique');
    if (!item.query.trim()) throw new Error('Agent Memory eval queries must not be empty');
    if (new Set(item.relevantMemoryIds).size !== item.relevantMemoryIds.length) {
      throw new Error(`Agent Memory case ${item.id} repeats a relevance judgement`);
    }
    if (item.relevantMemoryIds.some((id) => !memoryIds.has(id))) {
      throw new Error(`Agent Memory case ${item.id} references an unknown memory`);
    }
    caseIds.add(item.id);
  }
};

export const evaluateAgentMemoryDataset = (
  dataset: AgentMemoryGoldDataset,
  options: {
    topK?: number;
    latencySamplesPerCase?: number;
    thresholds?: Partial<AgentMemoryEvaluationThresholds>;
  } = {},
): AgentMemoryEvaluationReport => {
  assertDataset(dataset);
  const topK = Math.max(1, Math.min(20, Math.floor(options.topK ?? 5)));
  const latencySamplesPerCase = Math.max(
    1,
    Math.min(1_000, Math.floor(options.latencySamplesPerCase ?? 25)),
  );
  const thresholds = {
    ...DEFAULT_AGENT_MEMORY_EVALUATION_THRESHOLDS,
    ...options.thresholds,
  };
  const memories = dataset.memories.map(toMemoryRow);
  const latencySamples: number[] = [];
  const cases: AgentMemoryEvaluationCaseResult[] = [];

  for (const evaluationCase of dataset.cases) {
    let retrieval = retrieveAgentMemories(memories, { query: evaluationCase.query });
    for (let sample = 0; sample < latencySamplesPerCase; sample += 1) {
      const startedAt = performance.now();
      retrieval = retrieveAgentMemories(memories, { query: evaluationCase.query });
      latencySamples.push(performance.now() - startedAt);
    }
    const retrievedMemoryIds = retrieval.memories.slice(0, topK).map((item) => item.id);
    const relevant = new Set(evaluationCase.relevantMemoryIds);
    const hitCount = retrievedMemoryIds.filter((id) => relevant.has(id)).length;
    const firstRelevantIndex = retrievedMemoryIds.findIndex((id) => relevant.has(id));
    cases.push({
      caseId: evaluationCase.id,
      relevantMemoryIds: [...evaluationCase.relevantMemoryIds],
      retrievedMemoryIds,
      recallAtK: relevant.size > 0 ? hitCount / relevant.size : null,
      reciprocalRank: relevant.size > 0 && firstRelevantIndex >= 0
        ? 1 / (firstRelevantIndex + 1)
        : relevant.size > 0 ? 0 : null,
      irrelevantRetrievedCount: retrievedMemoryIds.filter((id) => !relevant.has(id)).length,
      rankingMode: retrieval.mode,
    });
  }

  const positiveCases = cases.filter((item) => item.recallAtK !== null);
  const noRelevantCases = cases.filter((item) => item.recallAtK === null);
  const totalRetrieved = cases.reduce((sum, item) => sum + item.retrievedMemoryIds.length, 0);
  const irrelevantRetrieved = cases.reduce(
    (sum, item) => sum + item.irrelevantRetrievedCount,
    0,
  );
  const metrics = {
    recallAtK: mean(positiveCases.map((item) => item.recallAtK as number)),
    meanReciprocalRank: mean(positiveCases.map((item) => item.reciprocalRank as number)),
    irrelevantInjectionRate: totalRetrieved === 0 ? 0 : irrelevantRetrieved / totalRetrieved,
    noRelevantSafeRate: noRelevantCases.length === 0
      ? 1
      : noRelevantCases.filter((item) => item.retrievedMemoryIds.length === 0).length
        / noRelevantCases.length,
    p95RankLatencyMs: percentile(latencySamples, 0.95),
  };
  const failures: string[] = [];
  if (metrics.recallAtK < thresholds.recallAtK) failures.push('recall_at_k_below_threshold');
  if (metrics.meanReciprocalRank < thresholds.meanReciprocalRank) {
    failures.push('mrr_below_threshold');
  }
  if (metrics.irrelevantInjectionRate > thresholds.irrelevantInjectionRate) {
    failures.push('irrelevant_injection_rate_above_threshold');
  }
  if (metrics.noRelevantSafeRate < thresholds.noRelevantSafeRate) {
    failures.push('no_relevant_safe_rate_below_threshold');
  }
  if (metrics.p95RankLatencyMs > thresholds.p95RankLatencyMs) {
    failures.push('p95_rank_latency_above_threshold');
  }

  return {
    evaluatorVersion: AGENT_MEMORY_EVALUATOR_VERSION,
    datasetId: dataset.id,
    datasetFormatVersion: dataset.formatVersion,
    annotationPolicy: dataset.annotationPolicy,
    topK,
    caseCount: cases.length,
    positiveCaseCount: positiveCases.length,
    noRelevantCaseCount: noRelevantCases.length,
    candidateJudgementCount: dataset.memories.length * dataset.cases.length,
    ...metrics,
    latencyScope: 'in_process_ranker_only',
    thresholds,
    passed: failures.length === 0,
    failures,
    cases,
  };
};


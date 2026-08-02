import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';
import { ChatSource, RagQualitySummary, RagTraceStep } from '../lib/chatSources';
import { getDefaultChatModel } from '../lib/llmProviders';

type RagEvalRunStatus = 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';

export interface RagEvalMetricApplicability extends Record<string, unknown> {
  retrieval?: boolean;
  answer?: boolean;
  faithfulness?: boolean;
  overall?: boolean;
  expected_answer_support?: boolean;
  keyword_retrieval?: boolean;
  correctness?: boolean;
  completeness?: boolean;
  judge_faithfulness?: boolean;
  citation_precision?: boolean;
  citation_coverage?: boolean;
  citation_f1?: boolean;
  hallucination_rate?: boolean;
}

export interface RagEvalDatasetRow {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  cases?: RagEvalCaseRow[];
  runs?: RagEvalRunRow[];
}

export interface RagEvalEvaluationSpec extends Record<string, unknown> {
  tags?: string[];
  category?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  expected_chunk_ids?: string[];
  expected_evidence?: string[];
  expected_answerable?: boolean | null;
  expected_graph_relations?: Array<{
    source: string;
    relation: string;
    target: string;
    polarity?: 'affirmative' | 'negative';
    modality?: 'asserted' | 'conditional' | 'planned_or_obligatory' | 'historical';
  }>;
  human_scores?: Partial<Record<'correctness' | 'completeness' | 'faithfulness', number>>;
}

export interface RagEvalCaseRow {
  id: string;
  dataset_id: string;
  user_id: string;
  question: string;
  expected_answer: string;
  expected_keywords: string[];
  expected_source_files: string[];
  evaluation_spec: RagEvalEvaluationSpec;
  created_at: string;
  updated_at: string;
}

export interface RagEvalRunRow {
  id: string;
  dataset_id: string;
  user_id: string;
  status: RagEvalRunStatus;
  case_count: number;
  failed_count: number;
  average_overall_score: number;
  average_retrieval_score: number;
  average_answer_score: number;
  average_source_score: number;
  average_source_recall_score: number;
  average_source_precision_score: number;
  average_citation_accuracy_score: number;
  average_keyword_score: number;
  average_answer_keyword_score: number | null;
  average_grounding_score: number;
  average_judge_score: number;
  average_expected_answer_support_score: number;
  average_verification_score: number;
  duration_ms: number;
  queued_at: string;
  claimed_at?: string | null;
  worker_id?: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  last_error: string;
  deadline_at?: string | Date | null;
  case_timeout_ms: number;
  heartbeat_at?: string | Date | null;
  lease_expires_at?: string | Date | null;
  created_at: string;
  completed_at?: string | null;
  results?: RagEvalResultRow[];
  metric_applicability?: RagEvalMetricApplicability;
  advanced_metrics?: Record<string, unknown>;
  execution_snapshot?: Record<string, unknown>;
  baseline_run_id?: string | null;
}

export type CreatedRagEvalRunRow = RagEvalRunRow & {
  created: boolean;
};

type RagEvalRunClaimRow = RagEvalRunRow & {
  lease_token: string;
  deadline_at: string | Date;
  heartbeat_at: string | Date;
  lease_expires_at: string | Date;
};

export type ClaimedRagEvalRunJob = RagEvalRunClaimRow & {
  dataset: RagEvalDatasetRow & {
    cases: RagEvalCaseRow[];
  };
};

export interface RagEvalResultRow {
  id: string;
  run_id: string;
  case_id?: string | null;
  question: string;
  actual_answer: string;
  status: 'success' | 'failed';
  overall_score: number;
  retrieval_score: number;
  answer_score: number;
  source_score: number;
  source_recall_score: number;
  source_precision_score: number;
  citation_accuracy_score: number;
  keyword_score: number;
  answer_keyword_score: number | null;
  grounding_score: number;
  judge_score: number;
  correctness_score: number;
  completeness_score: number;
  faithfulness_score: number;
  citation_precision: number;
  citation_coverage: number;
  citation_f1: number;
  hallucination_rate: number;
  prompt_version: string;
  model_version: string;
  judge_version: string;
  verifier_version: string;
  claim_evaluation: Record<string, unknown>;
  expected_answer_support_score: number;
  expected_answer_support_label: string;
  verification_score: number;
  latency_ms: number;
  evidence_label: string;
  support_label: string;
  risk_level: string;
  matched_sources: unknown[];
  trace_summary: Record<string, unknown>;
  error_message: string;
  advanced_metrics?: Record<string, unknown>;
  created_at: string;
}

export interface RagEvalQualityTrendRun {
  id: string;
  status: RagEvalRunStatus;
  case_count: number;
  failed_count: number;
  average_overall_score: number;
  average_retrieval_score: number;
  average_answer_score: number;
  average_source_score: number;
  average_source_recall_score: number;
  average_source_precision_score: number;
  average_citation_accuracy_score: number;
  average_keyword_score: number;
  average_answer_keyword_score: number | null;
  average_grounding_score: number;
  average_judge_score: number;
  average_expected_answer_support_score: number;
  average_verification_score: number;
  duration_ms: number;
  created_at: string;
  completed_at?: string | null;
  metric_applicability?: RagEvalMetricApplicability;
}

export interface RagEvalLowScoreCase {
  result_id: string;
  run_id: string;
  question: string;
  status: 'success' | 'failed';
  overall_score: number;
  retrieval_score: number;
  answer_score: number;
  source_score: number;
  source_recall_score: number;
  source_precision_score: number;
  citation_accuracy_score: number;
  keyword_score: number;
  answer_keyword_score: number | null;
  grounding_score: number;
  judge_score: number;
  expected_answer_support_score: number;
  expected_answer_support_label: string;
  verification_score: number;
  latency_ms: number;
  evidence_label: string;
  support_label: string;
  risk_level: string;
  error_message: string;
  metric_applicability?: RagEvalMetricApplicability;
}

export interface RagEvalQualitySummary {
  dataset_id: string;
  run_count: number;
  latest_run_id?: string | null;
  trend_delta?: number | null;
  average_overall_score: number;
  average_retrieval_score: number;
  average_answer_score: number;
  average_source_score: number;
  average_source_recall_score: number;
  average_source_precision_score: number;
  average_citation_accuracy_score: number;
  average_keyword_score: number;
  average_answer_keyword_score: number | null;
  average_grounding_score: number;
  average_judge_score: number;
  average_expected_answer_support_score: number;
  average_verification_score: number;
  trend: RagEvalQualityTrendRun[];
  low_score_cases: RagEvalLowScoreCase[];
  metric_applicability?: RagEvalMetricApplicability;
  paired_comparison?: {
    baseline_run_id: string;
    current_run_id: string;
    matched_case_count: number;
    retrieval: { case_count: number; mean_delta: number | null; wins: number; ties: number; losses: number };
    answer: { case_count: number; mean_delta: number | null; wins: number; ties: number; losses: number };
    grounding: { case_count: number; mean_delta: number | null; wins: number; ties: number; losses: number };
  } | null;
}

export interface RagEvalHistoryItem {
  id: string;
  conversation_id: string;
  conversation_title: string;
  project_space_id?: string | null;
  project_space_name?: string | null;
  model?: string | null;
  assistant_message_id?: string | null;
  answer_preview: string;
  answer_length: number;
  mode: string;
  query: string;
  planned_queries: string[];
  trace_steps: RagTraceStep[];
  quality: Partial<RagQualitySummary>;
  retrieved_sources: ChatSource[];
  status: 'success' | 'partial' | 'failed' | string;
  created_at: string;
  updated_at: string;
}

interface RagEvalHistoryRow extends Omit<
  RagEvalHistoryItem,
  'answer_length' | 'planned_queries' | 'trace_steps' | 'quality' | 'retrieved_sources'
> {
  answer_length: number | string | null;
  planned_queries: string[] | string | null;
  trace_steps: RagTraceStep[] | string | null;
  quality: Partial<RagQualitySummary> | string | null;
  retrieved_sources: ChatSource[] | string | null;
}

const datasetColumns = `
  id,
  user_id,
  project_space_id,
  name,
  description,
  created_at,
  updated_at
`;

const caseColumns = `
  id,
  dataset_id,
  user_id,
  question,
  expected_answer,
  expected_keywords,
  expected_source_files,
  evaluation_spec,
  created_at,
  updated_at
`;

const runColumns = `
  id,
  dataset_id,
  user_id,
  status,
  case_count,
  failed_count,
  average_overall_score,
  average_retrieval_score,
  average_answer_score,
  average_source_score,
  average_source_recall_score,
  average_source_precision_score,
  average_citation_accuracy_score,
  average_keyword_score,
  average_answer_keyword_score,
  average_grounding_score,
  average_judge_score,
  average_expected_answer_support_score,
  average_verification_score,
  duration_ms,
  queued_at,
  claimed_at,
  worker_id,
  attempts,
  max_attempts,
  next_attempt_at,
  last_error,
  deadline_at,
  case_timeout_ms,
  created_at,
  completed_at,
  advanced_metrics,
  execution_snapshot,
  baseline_run_id
`;

const claimedRunColumns = `
  ${runColumns},
  lease_token,
  heartbeat_at,
  lease_expires_at
`;

interface RagEvalRunOutput {
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
  average_answer_keyword_score?: number | null;
  average_retrieval_overall_score?: number;
  average_grounding_score?: number;
  average_judge_score?: number;
  average_expected_answer_support_score?: number;
  average_verification_score?: number;
  advanced_metrics?: Record<string, unknown>;
  results: Array<{
    case_id: string;
    question: string;
    actual_answer?: string;
    status: 'success' | 'failed';
    overall_score: number;
    retrieval_score: number;
    answer_score: number;
    source_score: number;
    source_recall_score?: number;
    source_precision_score?: number;
    citation_accuracy_score?: number;
    keyword_score: number;
    answer_keyword_score?: number | null;
    grounding_score?: number;
    judge_score?: number;
    correctness_score?: number;
    completeness_score?: number;
    faithfulness_score?: number;
    citation_precision?: number;
    citation_coverage?: number;
    citation_f1?: number;
    hallucination_rate?: number;
    prompt_version?: string;
    model_version?: string;
    judge_version?: string;
    verifier_version?: string;
    claim_evaluation?: Record<string, unknown>;
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
    advanced_metrics?: Record<string, unknown>;
  }>;
}

const toCount = (value: number | string | null | undefined) => Number(value ?? 0);

const toJsonArray = <T>(value: T[] | string | null | undefined): T[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const toJsonObject = <T extends Record<string, unknown>>(value: T | string | null | undefined): T => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {} as T;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : ({} as T);
  } catch {
    return {} as T;
  }
};

const mapRagEvalHistoryItem = (row: RagEvalHistoryRow): RagEvalHistoryItem => ({
  ...row,
  answer_preview: row.answer_preview || '',
  answer_length: toCount(row.answer_length),
  planned_queries: toJsonArray<string>(row.planned_queries),
  trace_steps: toJsonArray<RagTraceStep>(row.trace_steps),
  quality: toJsonObject<Partial<RagQualitySummary>>(row.quality),
  retrieved_sources: toJsonArray<ChatSource>(row.retrieved_sources),
});

const getRunStatusFromOutput = (output: RagEvalRunOutput): RagEvalRunStatus => {
  if (output.failed_count === 0) return 'completed';
  if (output.failed_count === output.case_count) return 'failed';
  return 'partial';
};

export const listRagEvalDatasetsForUser = async (userId: string): Promise<RagEvalDatasetRow[]> => {
  const [{ rows: datasets }, { rows: cases }, { rows: runs }] = await Promise.all([
    query<RagEvalDatasetRow>(
      `select ${datasetColumns}
       from rag_eval_datasets d
       where d.user_id = $1
       order by d.updated_at desc`,
      [userId]
    ),
    query<RagEvalCaseRow>(
      `select ${caseColumns}
       from rag_eval_cases
       where user_id = $1
       order by created_at asc`,
      [userId]
    ),
    query<RagEvalRunRow>(
      `select ${runColumns}
       from rag_eval_runs
       where user_id = $1
       order by created_at desc
       limit 100`,
      [userId]
    ),
  ]);
  const applicabilityByRun = await getRunMetricApplicability(runs.map((run) => run.id));

  const casesByDataset = new Map<string, RagEvalCaseRow[]>();
  cases.forEach((item) => {
    casesByDataset.set(item.dataset_id, [...(casesByDataset.get(item.dataset_id) || []), item]);
  });

  const runsByDataset = new Map<string, RagEvalRunRow[]>();
  runs.forEach((item) => {
    const metricApplicability = applicabilityByRun.get(item.id);
    const run = metricApplicability
      ? { ...item, metric_applicability: metricApplicability }
      : item;
    runsByDataset.set(item.dataset_id, [...(runsByDataset.get(item.dataset_id) || []), run]);
  });

  return datasets.map((dataset) => ({
    ...dataset,
    cases: casesByDataset.get(dataset.id) || [],
    runs: runsByDataset.get(dataset.id) || [],
  }));
};

export const createRagEvalDatasetForUser = async (input: {
  userId: string;
  projectSpaceId?: string | null;
  name: string;
  description?: string;
}) => {
  const { rows } = await query<RagEvalDatasetRow>(
    `insert into rag_eval_datasets (user_id, project_space_id, name, description)
     values ($1, $2, $3, $4)
     returning ${datasetColumns}`,
    [input.userId, input.projectSpaceId || null, input.name, input.description || '']
  );
  return { ...rows[0], cases: [], runs: [] };
};

export const updateRagEvalDatasetForUser = async (input: {
  userId: string;
  datasetId: string;
  projectSpaceId?: string | null;
  name: string;
  description?: string;
}) => {
  const { rows } = await query<RagEvalDatasetRow>(
    `update rag_eval_datasets
     set name = $3,
         description = $4,
         project_space_id = $5,
         updated_at = now()
     where id = $1 and user_id = $2
     returning ${datasetColumns}`,
    [
      input.datasetId,
      input.userId,
      input.name,
      input.description || '',
      input.projectSpaceId || null,
    ]
  );
  return rows[0] || null;
};

export const deleteRagEvalDatasetForUser = async (datasetId: string, userId: string) => {
  const { rowCount } = await query(
    `delete from rag_eval_datasets
     where id = $1 and user_id = $2`,
    [datasetId, userId]
  );
  return (rowCount ?? 0) > 0;
};

export const createRagEvalCaseForUser = async (input: {
  userId: string;
  datasetId: string;
  question: string;
  expectedAnswer?: string;
  expectedKeywords?: string[];
  expectedSourceFiles?: string[];
  evaluationSpec?: RagEvalEvaluationSpec;
  maxCases?: number;
}) => {
  const maxCases = input.maxCases ?? 50;

  return withTransaction(async (client) => {
    const { rows: datasets } = await client.query<Pick<RagEvalDatasetRow, 'id' | 'user_id' | 'project_space_id'>>(
      `select id, user_id, project_space_id
       from rag_eval_datasets
       where id = $1 and user_id = $2
       for update`,
      [input.datasetId, input.userId]
    );
    const dataset = datasets[0];
    if (!dataset) return null;

    const { rows: counts } = await client.query<{ case_count: number | string }>(
      `select count(*)::int as case_count
       from rag_eval_cases
       where dataset_id = $1`,
      [dataset.id]
    );
    const case_count = Number(counts[0]?.case_count ?? 0);
    if (case_count >= maxCases) return null;

    const { rows } = await client.query<RagEvalCaseRow>(
      `insert into rag_eval_cases (
         dataset_id,
         user_id,
         question,
         expected_answer,
         expected_keywords,
         expected_source_files,
         evaluation_spec
       )
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${caseColumns}`,
      [
        dataset.id,
        dataset.user_id,
        input.question,
        input.expectedAnswer || '',
        input.expectedKeywords || [],
        input.expectedSourceFiles || [],
        input.evaluationSpec || {},
      ]
    );
    await client.query(
      `update rag_eval_datasets
       set updated_at = now()
       where id = $1`,
      [dataset.id]
    );
    return rows[0] || null;
  });
};

export const deleteRagEvalCaseForUser = async (caseId: string, userId: string) => {
  return withTransaction(async (client) => {
    const { rows: datasets } = await client.query<{ id: string }>(
      `select d.id
       from rag_eval_datasets d
       join rag_eval_cases c on c.dataset_id = d.id
       where c.id = $1 and c.user_id = $2 and d.user_id = $2
       for update of d`,
      [caseId, userId]
    );
    const dataset = datasets[0];
    if (!dataset) return false;

    const { rowCount } = await client.query(
      `delete from rag_eval_cases
       where id = $1 and user_id = $2`,
      [caseId, userId]
    );
    if ((rowCount ?? 0) > 0) {
      await client.query(
        `update rag_eval_datasets
         set updated_at = now()
         where id = $1`,
        [dataset.id]
      );
    }
    return (rowCount ?? 0) > 0;
  });
};

export const getRagEvalDatasetWithCasesForUser = async (datasetId: string, userId: string) => {
  const { rows: datasets } = await query<RagEvalDatasetRow>(
    `select ${datasetColumns}
     from rag_eval_datasets d
     where d.id = $1 and d.user_id = $2`,
    [datasetId, userId]
  );
  const dataset = datasets[0];
  if (!dataset) return null;

  const { rows: cases } = await query<RagEvalCaseRow>(
    `select ${caseColumns}
     from rag_eval_cases
     where dataset_id = $1 and user_id = $2
     order by created_at asc`,
    [datasetId, userId]
  );

  return { ...dataset, cases };
};

export const getRagEvalRunForUser = async (runId: string, userId: string) => {
  const { rows: runs } = await query<RagEvalRunRow>(
    `select ${runColumns}
     from rag_eval_runs
     where id = $1 and user_id = $2`,
    [runId, userId]
  );
  const run = runs[0];
  if (!run) return null;

  const { rows: results } = await query<RagEvalResultRow>(
    `select *
     from rag_eval_results
     where run_id = $1
     order by created_at asc`,
    [runId]
  );
  const metricApplicability = (await getRunMetricApplicability([runId])).get(runId);

  return metricApplicability
    ? { ...run, results, metric_applicability: metricApplicability }
    : { ...run, results };
};

export const getRagEvalQualitySummaryForUser = async (
  datasetId: string,
  userId: string
): Promise<RagEvalQualitySummary | null> => {
  const { rows: datasets } = await query<Pick<RagEvalDatasetRow, 'id'>>(
    `select id
     from rag_eval_datasets
     where id = $1 and user_id = $2`,
    [datasetId, userId]
  );

  if (!datasets[0]) return null;

  const { rows: recentRuns } = await query<RagEvalRunRow>(
    `select ${runColumns}
     from rag_eval_runs
     where dataset_id = $1
       and user_id = $2
       and status in ('completed', 'partial', 'failed')
     order by created_at desc
     limit 10`,
    [datasetId, userId]
  );
  const applicabilityByRun = await getRunMetricApplicability(recentRuns.map((run) => run.id));
  const runsWithApplicability = recentRuns.map((run) => {
    const metricApplicability = applicabilityByRun.get(run.id);
    return metricApplicability
      ? { ...run, metric_applicability: metricApplicability }
      : run;
  });

  const latestRun = runsWithApplicability[0];
  const scoredRuns = runsWithApplicability.filter(
    (run) => run.metric_applicability?.overall === true
  );
  const latestScoredRun = scoredRuns[0];
  const previousScoredRun = scoredRuns[1];
  const trend = scoredRuns
    .slice()
    .reverse()
    .map((run) => ({
      id: run.id,
      status: run.status,
      case_count: run.case_count,
      failed_count: run.failed_count,
      average_overall_score: run.average_overall_score,
      average_retrieval_score: run.average_retrieval_score,
      average_answer_score: run.average_answer_score,
      average_source_score: run.average_source_score,
      average_source_recall_score: run.average_source_recall_score,
      average_source_precision_score: run.average_source_precision_score,
      average_citation_accuracy_score: run.average_citation_accuracy_score,
      average_keyword_score: run.average_keyword_score,
      average_answer_keyword_score: run.average_answer_keyword_score,
      average_grounding_score: run.average_grounding_score,
      average_judge_score: run.average_judge_score,
      average_expected_answer_support_score: run.average_expected_answer_support_score,
      average_verification_score: run.average_verification_score,
      duration_ms: run.duration_ms,
      created_at: run.created_at,
      completed_at: run.completed_at,
      metric_applicability: run.metric_applicability,
    }));

  const lowScoreCases = latestScoredRun
    ? (await query<RagEvalLowScoreCase>(
      `select
         id as result_id,
         run_id,
         question,
         status,
         overall_score,
         retrieval_score,
         answer_score,
         source_score,
         source_recall_score,
         source_precision_score,
         citation_accuracy_score,
         keyword_score,
         answer_keyword_score,
         grounding_score,
         judge_score,
         expected_answer_support_score,
         expected_answer_support_label,
         verification_score,
         latency_ms,
         evidence_label,
         support_label,
         risk_level,
         trace_summary->'metric_applicability' as metric_applicability,
         error_message
       from rag_eval_results
       where run_id = $1
         and trace_summary #>> '{metric_applicability,overall}' = 'true'
       order by overall_score asc, retrieval_score asc, answer_score asc, created_at asc
       limit 5`,
      [latestScoredRun.id]
    )).rows
    : [];

  const pairedRows = latestRun?.baseline_run_id
    ? (await query<{
      retrieval_delta: number | string;
      answer_delta: number | string | null;
      grounding_delta: number | string | null;
    }>(
      `select
         current.retrieval_score - baseline.retrieval_score as retrieval_delta,
         case
           when current.trace_summary #>> '{metric_applicability,answer}' = 'true'
            and baseline.trace_summary #>> '{metric_applicability,answer}' = 'true'
           then current.answer_score - baseline.answer_score
           else null
         end as answer_delta,
         case
           when current.trace_summary #>> '{metric_applicability,faithfulness}' = 'true'
            and baseline.trace_summary #>> '{metric_applicability,faithfulness}' = 'true'
           then current.grounding_score - baseline.grounding_score
           else null
         end as grounding_delta
       from rag_eval_results current
       join rag_eval_results baseline
         on baseline.run_id = $2
        and (
          (current.case_id is not null and baseline.case_id = current.case_id)
          or (current.case_id is null and baseline.question = current.question)
        )
       where current.run_id = $1
         and current.status = 'success'
         and baseline.status = 'success'
         and current.trace_summary #>> '{metric_applicability,retrieval}' = 'true'
         and baseline.trace_summary #>> '{metric_applicability,retrieval}' = 'true'`,
      [latestRun.id, latestRun.baseline_run_id],
    )).rows
    : [];
  const summarizeDeltas = (values: Array<number | string | null>) => {
    const deltas = values
      .filter((value): value is number | string => value !== null)
      .map(Number)
      .filter(Number.isFinite);
    return {
      case_count: deltas.length,
      mean_delta: deltas.length
        ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
        : null,
      wins: deltas.filter((value) => value > 1e-9).length,
      ties: deltas.filter((value) => Math.abs(value) <= 1e-9).length,
      losses: deltas.filter((value) => value < -1e-9).length,
    };
  };
  const pairedComparison = latestRun?.baseline_run_id
    ? {
      baseline_run_id: latestRun.baseline_run_id,
      current_run_id: latestRun.id,
      matched_case_count: pairedRows.length,
      retrieval: summarizeDeltas(pairedRows.map((row) => row.retrieval_delta)),
      answer: summarizeDeltas(pairedRows.map((row) => row.answer_delta)),
      grounding: summarizeDeltas(pairedRows.map((row) => row.grounding_delta)),
    }
    : null;

  return {
    dataset_id: datasetId,
    run_count: recentRuns.length,
    latest_run_id: latestRun?.id || null,
    trend_delta: latestScoredRun && previousScoredRun
      ? latestScoredRun.average_overall_score - previousScoredRun.average_overall_score
      : null,
    average_overall_score: latestRun?.average_overall_score || 0,
    average_retrieval_score: latestRun?.average_retrieval_score || 0,
    average_answer_score: latestRun?.average_answer_score || 0,
    average_source_score: latestRun?.average_source_score || 0,
    average_source_recall_score: latestRun?.average_source_recall_score || 0,
    average_source_precision_score: latestRun?.average_source_precision_score || 0,
    average_citation_accuracy_score: latestRun?.average_citation_accuracy_score || 0,
    average_keyword_score: latestRun?.average_keyword_score || 0,
    average_answer_keyword_score: latestRun?.average_answer_keyword_score ?? null,
    average_grounding_score: latestRun?.average_grounding_score || 0,
    average_judge_score: latestRun?.average_judge_score || 0,
    average_expected_answer_support_score: latestRun?.average_expected_answer_support_score || 0,
    average_verification_score: latestRun?.average_verification_score || 0,
    metric_applicability: latestRun?.metric_applicability,
    trend,
    low_score_cases: lowScoreCases,
    paired_comparison: pairedComparison,
  };
};

export const listHistoricalRagRunsForUser = async (
  userId: string,
  limit = 50
): Promise<RagEvalHistoryItem[]> => {
  const { rows } = await query<RagEvalHistoryRow>(
    `select
       rr.id,
       rr.conversation_id,
       c.title as conversation_title,
       c.project_space_id,
       ps.name as project_space_name,
       coalesce(c.model, $3) as model,
       rr.assistant_message_id,
       left(coalesce(am.content, ''), 640) as answer_preview,
       char_length(coalesce(am.content, ''))::int as answer_length,
       rr.mode,
       rr.query,
       rr.planned_queries,
       rr.trace_steps,
       rr.quality,
       rr.retrieved_sources,
       rr.status,
       rr.created_at,
       rr.updated_at
     from rag_runs rr
     join conversations c on c.id = rr.conversation_id
     left join messages am on am.id = rr.assistant_message_id
       and am.conversation_id = rr.conversation_id
     left join project_spaces ps on ps.id = c.project_space_id
       and ps.user_id = rr.user_id
     where rr.user_id = $1
       and c.user_id = $1
     order by rr.created_at desc
     limit $2`,
    [userId, limit, getDefaultChatModel()]
  );

  return rows.map(mapRagEvalHistoryItem);
};

export const createRunningRagEvalRunForUser = async (input: {
  userId: string;
  datasetId: string;
  caseCount: number;
}): Promise<CreatedRagEvalRunRow> => {
  return withTransaction(async (client) => {
    const { rows: datasets } = await client.query<Pick<RagEvalDatasetRow, 'id' | 'user_id' | 'project_space_id'>>(
      `select id, user_id, project_space_id
       from rag_eval_datasets
       where id = $1 and user_id = $2
       for update`,
      [input.datasetId, input.userId]
    );
    const dataset = datasets[0];
    if (!dataset) throw new Error('RAG eval dataset not found');

    const { rows: counts } = await client.query<{ case_count: number | string }>(
      `select count(*)::int as case_count
       from rag_eval_cases
       where dataset_id = $1 and user_id = $2`,
      [dataset.id, dataset.user_id]
    );
    const actualCaseCount = Number(counts[0]?.case_count ?? 0);
    if (actualCaseCount === 0) throw new Error('RAG eval dataset has no cases');

    const { rows: indexScopes } = await client.query<{
      project_space_id: string;
      knowledge_version: number | string;
      vector_version: number | string | null;
      bm25_version: number | string | null;
      graph_version: number | string | null;
      chunk_strategy_version: string | null;
      embedding_model: string | null;
      embedding_dimension: number | null;
      settings_fingerprint: string | null;
    }>(
      `select
         ps.id::text as project_space_id,
         ps.knowledge_version,
         riv.vector_version,
         riv.bm25_version,
         riv.graph_version,
         riv.chunk_strategy_version,
         riv.embedding_model,
         riv.embedding_dimension,
         riv.settings_fingerprint
       from project_spaces ps
       left join rag_index_versions riv
         on riv.user_id = ps.user_id and riv.project_space_id = ps.id
       where ps.user_id = $1
         and ($2::uuid is null or ps.id = $2::uuid)
       order by ps.id`,
      [dataset.user_id, dataset.project_space_id || null],
    );
    const executionSnapshot = {
      snapshot_version: 'rag-eval-execution-v1',
      captured_at: new Date().toISOString(),
      benchmark_type: 'retrieval_evidence',
      dataset: {
        id: dataset.id,
        case_count: actualCaseCount,
        project_space_id: dataset.project_space_id || null,
      },
      retrieval: { limit: 10, threshold: 0.1 },
      generation: {
        requested_model: getDefaultChatModel(),
        temperature: 0,
      },
      execution: {
        case_timeout_ms: serverEnv.RAG_EVAL_CASE_TIMEOUT_MS,
        run_timeout_ms: serverEnv.RAG_EVAL_RUN_TIMEOUT_MS,
      },
      index_scopes: indexScopes.map((scope) => ({
        ...scope,
        knowledge_version: Number(scope.knowledge_version),
        vector_version: scope.vector_version === null ? null : Number(scope.vector_version),
        bm25_version: scope.bm25_version === null ? null : Number(scope.bm25_version),
        graph_version: scope.graph_version === null ? null : Number(scope.graph_version),
      })),
    };

    const { rows } = await client.query<RagEvalRunRow>(
      `insert into rag_eval_runs (
         dataset_id,
         user_id,
         status,
         case_count,
         max_attempts,
         case_timeout_ms,
         deadline_at,
         execution_snapshot,
         baseline_run_id
       )
       values (
         $1,
         $2,
         'running',
         $3,
         $4,
         $5,
         now() + ($6::double precision * interval '1 millisecond'),
         $7::jsonb,
         (
           select previous.id
           from rag_eval_runs previous
           where previous.dataset_id = $1
             and previous.user_id = $2
             and previous.status in ('completed', 'partial')
           order by previous.created_at desc
           limit 1
         )
       )
       on conflict (dataset_id) where status = 'running' do nothing
       returning ${runColumns}`,
      [
        dataset.id,
        dataset.user_id,
        actualCaseCount,
        serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS,
        serverEnv.RAG_EVAL_CASE_TIMEOUT_MS,
        serverEnv.RAG_EVAL_RUN_TIMEOUT_MS,
        JSON.stringify(executionSnapshot),
      ]
    );

    if (rows[0]) {
      await client.query(
        `insert into rag_eval_run_cases (
           run_id,
           case_id,
           ordinal,
           question,
           expected_answer,
           expected_keywords,
           expected_source_files,
           evaluation_spec,
           case_created_at,
           case_updated_at
         )
         select
           $1,
           c.id,
           (row_number() over (order by c.created_at asc, c.id asc) - 1)::int,
           c.question,
           c.expected_answer,
           c.expected_keywords,
           c.expected_source_files,
           c.evaluation_spec,
           c.created_at,
           c.updated_at
         from rag_eval_cases c
         where c.dataset_id = $2 and c.user_id = $3
         order by c.created_at asc, c.id asc`,
        [rows[0].id, dataset.id, dataset.user_id]
      );
      await client.query(
        `update rag_eval_datasets
         set updated_at = now()
         where id = $1 and user_id = $2`,
        [dataset.id, dataset.user_id]
      );

      return { ...rows[0], results: [], created: true };
    }

    const { rows: runningRows } = await client.query<RagEvalRunRow>(
      `select ${runColumns}
       from rag_eval_runs
       where dataset_id = $1 and user_id = $2 and status = 'running'
       order by created_at desc
       limit 1`,
      [dataset.id, dataset.user_id]
    );

    if (!runningRows[0]) {
      throw new Error('Unable to create or locate running RAG eval run');
    }

    return { ...runningRows[0], results: [], created: false };
  });
};

export const claimNextRagEvalRunJob = async (input: {
  workerId: string;
  runId?: string;
  retryBaseDelayMs?: number;
  staleAfterMs?: number;
  maxAttempts?: number;
  runTimeoutMs?: number;
}): Promise<ClaimedRagEvalRunJob | null> => {
  const retryBaseDelayMs = input.retryBaseDelayMs ?? serverEnv.RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS;
  const staleAfterMs = input.staleAfterMs ?? serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS;
  const maxAttempts = input.maxAttempts ?? serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS;
  const runTimeoutMs = input.runTimeoutMs ?? serverEnv.RAG_EVAL_RUN_TIMEOUT_MS;

  return withTransaction(async (client) => {
    const { rows: runRows } = await client.query<RagEvalRunClaimRow>(
      `with next_run as (
         select id
          from rag_eval_runs
          where status = 'running'
            and ($6::uuid is null or id = $6::uuid)
           and attempts < greatest(max_attempts, $3)
           and (deadline_at is null or deadline_at > now())
           and (
             (
               claimed_at is null
               and (
                 next_attempt_at is null
                 or next_attempt_at <= now()
               )
             )
             or (
               claimed_at is not null
               and (
                 lease_expires_at is null
                 or lease_expires_at <= now()
               )
             )
             or (
               claimed_at is null
               and next_attempt_at is null
               and attempts > 0
               and queued_at + (
                 least(3600000::double precision, $1::double precision * power(2, greatest(attempts - 1, 0)))
                 * interval '1 millisecond'
               ) <= now()
             )
           )
         order by coalesce(next_attempt_at, queued_at, created_at) asc, created_at asc
         limit 1
         for update skip locked
       )
       update rag_eval_runs
       set claimed_at = now(),
           worker_id = $4,
           lease_token = gen_random_uuid(),
           heartbeat_at = now(),
           lease_expires_at = now() + ($2::double precision * interval '1 millisecond'),
           deadline_at = coalesce(
             deadline_at,
             now() + ($5::double precision * interval '1 millisecond')
           ),
           attempts = least(greatest(max_attempts, $3), attempts + 1),
           max_attempts = greatest(max_attempts, $3),
           next_attempt_at = null,
           last_error = '',
           queued_at = coalesce(queued_at, created_at)
       where id in (select id from next_run)
       returning ${claimedRunColumns}`,
      [retryBaseDelayMs, staleAfterMs, maxAttempts, input.workerId, runTimeoutMs, input.runId || null]
    );

    const run = runRows[0];
    if (!run) return null;

    const { rows: datasetRows } = await client.query<RagEvalDatasetRow>(
      `select ${datasetColumns}
       from rag_eval_datasets
       where id = $1 and user_id = $2`,
      [run.dataset_id, run.user_id]
    );

    const dataset = datasetRows[0];
    if (!dataset) return null;

    const { rows: cases } = await client.query<RagEvalCaseRow>(
      `select
         snapshot.case_id as id,
         run.dataset_id,
         run.user_id,
         snapshot.question,
         snapshot.expected_answer,
         snapshot.expected_keywords,
         snapshot.expected_source_files,
         snapshot.evaluation_spec,
         snapshot.case_created_at as created_at,
         snapshot.case_updated_at as updated_at
       from rag_eval_run_cases snapshot
       join rag_eval_runs run on run.id = snapshot.run_id
       where snapshot.run_id = $1
       order by snapshot.ordinal asc`,
      [run.id]
    );
    if (cases.length !== toCount(run.case_count)) {
      throw new Error('RAG eval run case snapshot is incomplete');
    }

    return {
      ...run,
      dataset: {
        ...dataset,
        cases,
      },
    };
  });
};

interface RagEvalRunApplicabilityRow {
  run_id: string;
  metric_applicability: RagEvalMetricApplicability | string | null;
}

const getRunMetricApplicability = async (runIds: string[]) => {
  if (runIds.length === 0) return new Map<string, RagEvalMetricApplicability>();

  const { rows } = await query<RagEvalRunApplicabilityRow>(
    `select
       run_id,
       jsonb_strip_nulls(jsonb_build_object(
         'retrieval', bool_or((trace_summary #>> '{metric_applicability,retrieval}') = 'true')
           filter (where (trace_summary #> '{metric_applicability}') ? 'retrieval'),
         'answer', bool_or((trace_summary #>> '{metric_applicability,answer}') = 'true')
           filter (where (trace_summary #> '{metric_applicability}') ? 'answer'),
         'faithfulness', bool_or((trace_summary #>> '{metric_applicability,faithfulness}') = 'true')
           filter (where (trace_summary #> '{metric_applicability}') ? 'faithfulness'),
         'overall', bool_or((trace_summary #>> '{metric_applicability,overall}') = 'true')
           filter (where (trace_summary #> '{metric_applicability}') ? 'overall'),
         'expected_answer_support', bool_or((trace_summary #>> '{metric_applicability,expected_answer_support}') = 'true')
           filter (where (trace_summary #> '{metric_applicability}') ? 'expected_answer_support'),
         'keyword_retrieval', bool_or((trace_summary #>> '{metric_applicability,keyword_retrieval}') = 'true')
           filter (where (trace_summary #> '{metric_applicability}') ? 'keyword_retrieval')
       )) as metric_applicability
     from rag_eval_results
     where run_id = any($1::uuid[])
     group by run_id`,
    [runIds],
  );

  return new Map(rows.flatMap((row) => {
    const applicability = toJsonObject<RagEvalMetricApplicability>(row.metric_applicability);
    return Object.keys(applicability).length > 0 ? [[row.run_id, applicability] as const] : [];
  }));
};

export const claimRagEvalRunJobById = async (
  runId: string,
  input: Omit<Parameters<typeof claimNextRagEvalRunJob>[0], 'runId'>
) => claimNextRagEvalRunJob({ ...input, runId });

export const listDispatchableRagEvalRunIds = async (
  limit = 50,
  runQuery: typeof query = query
) => {
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const { rows } = await runQuery<{ id: string }>(
    `select id
     from rag_eval_runs
     where status = 'running'
       and attempts < greatest(max_attempts, $1)
       and (deadline_at is null or deadline_at > now())
       and (
         (
           claimed_at is null
           and (next_attempt_at is null or next_attempt_at <= now())
         )
         or (
           claimed_at is not null
           and (lease_expires_at is null or lease_expires_at <= now())
         )
       )
     order by coalesce(next_attempt_at, queued_at, created_at) asc, created_at asc
     limit $2`,
    [serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS, boundedLimit]
  );
  return rows.map((row) => row.id);
};

export const renewRagEvalRunLease = async (input: {
  runId: string;
  workerId: string;
  leaseToken: string;
  leaseDurationMs?: number;
}) => {
  const leaseDurationMs = input.leaseDurationMs ?? serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS;
  const { rows } = await query<{ lease_expires_at: string | Date }>(
    `update rag_eval_runs
     set heartbeat_at = now(),
         lease_expires_at = now() + ($4::double precision * interval '1 millisecond')
     where id = $1
       and status = 'running'
       and worker_id = $2
       and lease_token = $3
       and lease_expires_at > now()
       and deadline_at > now()
     returning lease_expires_at`,
    [input.runId, input.workerId, input.leaseToken, leaseDurationMs]
  );

  const leaseExpiresAt = rows[0]?.lease_expires_at;
  if (!leaseExpiresAt) return null;
  return leaseExpiresAt instanceof Date ? leaseExpiresAt.toISOString() : String(leaseExpiresAt);
};

export const resetStaleRagEvalRunJobs = async (staleAfterMs: number) => {
  const { rowCount } = await query(
    `update rag_eval_runs
     set claimed_at = null,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         next_attempt_at = now(),
         last_error = case
           when last_error = '' then 'RAG eval worker claim expired'
           else last_error
         end
     where status = 'running'
       and claimed_at is not null
       and (
         (lease_token is not null and lease_expires_at <= now())
         or (
           lease_token is null
           and claimed_at <= now() - ($1::double precision * interval '1 millisecond')
         )
       )
       and (deadline_at is null or deadline_at > now())
       and attempts < max_attempts`,
    [staleAfterMs]
  );

  return rowCount ?? 0;
};

export const failStaleRunningRagEvalRuns = async (staleAfterMs: number) => {
  const { rowCount } = await query(
    `update rag_eval_runs
     set status = 'failed',
         failed_count = case_count,
         claimed_at = null,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         next_attempt_at = null,
         last_error = case
           when last_error = '' then 'RAG eval run exceeded stale timeout'
           else last_error
         end,
         completed_at = now()
     where status = 'running'
       and (
         deadline_at <= now()
         or (
           created_at < now() - ($1::text || ' milliseconds')::interval
           and attempts >= max_attempts
         )
       )`,
    [staleAfterMs]
  );

  return rowCount ?? 0;
};

export const completeRagEvalRunWithResults = async (input: {
  userId: string;
  runId: string;
  workerId: string;
  leaseToken: string;
  output: RagEvalRunOutput;
}) => {
  return withTransaction(async (client) => {
    const runStatus = getRunStatusFromOutput(input.output);

    const { rows: runRows } = await client.query<RagEvalRunRow>(
      `update rag_eval_runs
       set status = $3,
           case_count = $4,
           failed_count = $5,
           average_overall_score = $6,
           average_retrieval_score = $7,
           average_answer_score = $8,
           average_source_score = $9,
           average_source_recall_score = $10,
           average_source_precision_score = $11,
           average_citation_accuracy_score = $12,
           average_keyword_score = $13,
           average_answer_keyword_score = $14,
           average_grounding_score = $15,
           average_judge_score = $16,
           average_expected_answer_support_score = $17,
           average_verification_score = $18,
           duration_ms = $19,
           advanced_metrics = $20::jsonb,
           claimed_at = null,
           worker_id = null,
           lease_token = null,
           heartbeat_at = now(),
           lease_expires_at = null,
           next_attempt_at = null,
           last_error = '',
           completed_at = now()
       where id = $1
         and user_id = $2
         and status in ('running')
         and worker_id = $21
         and lease_token = $22
         and lease_expires_at > now()
         and deadline_at > now()
       returning ${runColumns}`,
      [
        input.runId,
        input.userId,
        runStatus,
        input.output.case_count,
        input.output.failed_count,
        input.output.average_overall_score,
        input.output.average_retrieval_score,
        input.output.average_answer_score,
        input.output.average_source_score,
        input.output.average_source_recall_score ?? input.output.average_source_score,
        input.output.average_source_precision_score ?? 0,
        input.output.average_citation_accuracy_score ?? 0,
        input.output.average_keyword_score,
        null,
        input.output.average_grounding_score ?? 0,
        input.output.average_judge_score ?? 0,
        input.output.average_expected_answer_support_score ?? 0,
        input.output.average_verification_score ?? 0,
        input.output.duration_ms,
        JSON.stringify(input.output.advanced_metrics || {}),
        input.workerId,
        input.leaseToken,
      ]
    );

    const run = runRows[0];
    if (!run) return null;

    const resultRows: RagEvalResultRow[] = [];
    for (const result of input.output.results) {
      const { rows } = await client.query<RagEvalResultRow>(
        `insert into rag_eval_results (
           run_id,
           case_id,
           question,
           status,
           overall_score,
           retrieval_score,
           answer_score,
           source_score,
           source_recall_score,
           source_precision_score,
           citation_accuracy_score,
           keyword_score,
           answer_keyword_score,
           grounding_score,
           judge_score,
           expected_answer_support_score,
           expected_answer_support_label,
           verification_score,
           latency_ms,
           evidence_label,
           support_label,
           risk_level,
           matched_sources,
           trace_summary,
           error_message,
           actual_answer,
           correctness_score,
           completeness_score,
           faithfulness_score,
           citation_precision,
           citation_coverage,
           citation_f1,
           hallucination_rate,
           prompt_version,
           model_version,
           judge_version,
           verifier_version,
           claim_evaluation,
           advanced_metrics
          )
          values ($1, (select id from rag_eval_cases where id = $2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39)
         returning *`,
        [
          run.id,
          result.case_id || null,
          result.question,
          result.status,
          result.overall_score,
          result.retrieval_score,
          result.answer_score,
          result.source_score,
          result.source_recall_score ?? result.source_score,
          result.source_precision_score ?? 0,
          result.citation_accuracy_score ?? 0,
          result.keyword_score,
          null,
          result.grounding_score ?? 0,
          result.judge_score ?? 0,
          result.expected_answer_support_score ?? 0,
          result.expected_answer_support_label || 'unknown',
          result.verification_score ?? 0,
          result.latency_ms ?? 0,
          result.evidence_label,
          result.support_label || 'unsupported',
          result.risk_level || 'unknown',
          JSON.stringify(result.matched_sources || []),
          JSON.stringify(result.trace_summary || {}),
          result.error_message || '',
          result.actual_answer || '',
          result.correctness_score ?? 0,
          result.completeness_score ?? 0,
          result.faithfulness_score ?? 0,
          result.citation_precision ?? 0,
          result.citation_coverage ?? 0,
          result.citation_f1 ?? 0,
          result.hallucination_rate ?? 0,
          result.prompt_version || '',
          result.model_version || '',
          result.judge_version || '',
          result.verifier_version || '',
          JSON.stringify(result.claim_evaluation || {}),
          JSON.stringify(result.advanced_metrics || {}),
        ]
      );
      resultRows.push(rows[0]);
    }

    await client.query(
      `update rag_eval_datasets
       set updated_at = now()
       where id = $1 and user_id = $2`,
      [run.dataset_id, input.userId]
    );

    return { ...run, results: resultRows };
  });
};

export const failRagEvalRunForUser = async (input: {
  userId: string;
  runId: string;
  errorMessage: string;
  durationMs?: number;
  workerId: string;
  leaseToken: string;
}) => {
  const { rows } = await query<RagEvalRunRow>(
    `update rag_eval_runs
     set status = 'failed',
         failed_count = case_count,
         duration_ms = $3,
         claimed_at = null,
         worker_id = null,
         lease_token = null,
         heartbeat_at = now(),
         lease_expires_at = null,
         next_attempt_at = null,
         last_error = $4,
         completed_at = now()
     where id = $1
       and user_id = $2
       and status in ('running')
       and worker_id = $5
       and lease_token = $6
       and lease_expires_at > now()
       and deadline_at > now()
     returning ${runColumns}`,
    [
      input.runId,
      input.userId,
      input.durationMs || 0,
      input.errorMessage,
      input.workerId,
      input.leaseToken,
    ]
  );

  if (!rows[0]) return null;

  console.error('RAG eval run failed');

  return { ...rows[0], results: [] };
};

export const markRagEvalRunAttemptFailed = async (input: {
  run: Pick<RagEvalRunRow, 'id' | 'user_id' | 'attempts' | 'max_attempts' | 'deadline_at'>;
  errorMessage: string;
  durationMs?: number;
  workerId: string;
  leaseToken: string;
}) => {
  const maxAttempts = Math.max(
    input.run.max_attempts || 0,
    serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS
  );
  const attempts = input.run.attempts || 1;
  const deadlineAtMs = input.run.deadline_at ? new Date(input.run.deadline_at).getTime() : null;
  const exhausted = attempts >= maxAttempts
    || (deadlineAtMs !== null && Number.isFinite(deadlineAtMs) && deadlineAtMs <= Date.now());
  const retryDelayMs = Math.min(
    60 * 60 * 1000,
    serverEnv.RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS * 2 ** Math.max(attempts - 1, 0)
  );

  const { rows } = await query<RagEvalRunRow>(
    `update rag_eval_runs
     set status = case when $5 then 'failed' else status end,
         failed_count = case when $5 then case_count else failed_count end,
         duration_ms = $6,
         claimed_at = null,
         worker_id = null,
         lease_token = null,
         heartbeat_at = now(),
         lease_expires_at = null,
         max_attempts = $4,
         next_attempt_at = case
           when $5 then null
           else now() + ($7::double precision * interval '1 millisecond')
         end,
         last_error = $3,
         completed_at = case when $5 then now() else completed_at end
     where id = $1
       and user_id = $2
       and status = 'running'
       and worker_id = $8
       and lease_token = $9
     returning ${runColumns}`,
    [
      input.run.id,
      input.run.user_id,
      exhausted
        ? `Max attempts reached after ${attempts} attempts: ${input.errorMessage}`
        : input.errorMessage,
      maxAttempts,
      exhausted,
      input.durationMs || 0,
      retryDelayMs,
      input.workerId,
      input.leaseToken,
    ]
  );

  return rows[0] || null;
};

export const cancelRagEvalRunForUser = async (runId: string, userId: string) => {
  const { rows } = await query<RagEvalRunRow>(
    `update rag_eval_runs
     set status = 'cancelled',
         duration_ms = greatest(duration_ms, floor(extract(epoch from (now() - created_at)) * 1000)::int),
         claimed_at = null,
         worker_id = null,
         lease_token = null,
         heartbeat_at = now(),
         lease_expires_at = null,
         next_attempt_at = null,
         completed_at = now()
     where id = $1 and user_id = $2 and status = 'running'
     returning ${runColumns}`,
    [runId, userId]
  );

  return rows[0] ? { ...rows[0], results: [] } : null;
};

import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';
import { ChatSource, RagQualitySummary, RagTraceStep } from '../lib/chatSources';
import { getDefaultChatModel } from '../lib/llmProviders';

type RagEvalRunStatus = 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';

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

export interface RagEvalCaseRow {
  id: string;
  dataset_id: string;
  user_id: string;
  question: string;
  expected_answer: string;
  expected_keywords: string[];
  expected_source_files: string[];
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
  average_answer_keyword_score: number;
  average_grounding_score: number;
  average_judge_score: number;
  duration_ms: number;
  queued_at: string;
  claimed_at?: string | null;
  worker_id?: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  last_error: string;
  created_at: string;
  completed_at?: string | null;
  results?: RagEvalResultRow[];
}

export type CreatedRagEvalRunRow = RagEvalRunRow & {
  created: boolean;
};

export type ClaimedRagEvalRunJob = RagEvalRunRow & {
  dataset: RagEvalDatasetRow & {
    cases: RagEvalCaseRow[];
  };
};

export interface RagEvalResultRow {
  id: string;
  run_id: string;
  case_id?: string | null;
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
  answer_keyword_score: number;
  grounding_score: number;
  judge_score: number;
  latency_ms: number;
  evidence_label: string;
  matched_sources: unknown[];
  trace_summary: Record<string, unknown>;
  error_message: string;
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
  average_answer_keyword_score: number;
  average_grounding_score: number;
  average_judge_score: number;
  duration_ms: number;
  created_at: string;
  completed_at?: string | null;
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
  answer_keyword_score: number;
  grounding_score: number;
  judge_score: number;
  latency_ms: number;
  evidence_label: string;
  error_message: string;
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
  average_answer_keyword_score: number;
  average_grounding_score: number;
  average_judge_score: number;
  trend: RagEvalQualityTrendRun[];
  low_score_cases: RagEvalLowScoreCase[];
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
  duration_ms,
  queued_at,
  claimed_at,
  worker_id,
  attempts,
  max_attempts,
  next_attempt_at,
  last_error,
  created_at,
  completed_at
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

  const casesByDataset = new Map<string, RagEvalCaseRow[]>();
  cases.forEach((item) => {
    casesByDataset.set(item.dataset_id, [...(casesByDataset.get(item.dataset_id) || []), item]);
  });

  const runsByDataset = new Map<string, RagEvalRunRow[]>();
  runs.forEach((item) => {
    runsByDataset.set(item.dataset_id, [...(runsByDataset.get(item.dataset_id) || []), item]);
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
  maxCases?: number;
}) => {
  const { rows } = await query<RagEvalCaseRow>(
    `with scoped_dataset as (
       select d.id, d.user_id,
         (select count(*)::int from rag_eval_cases
          where dataset_id = d.id) as case_count
       from rag_eval_datasets d
       where d.id = $1 and d.user_id = $2
     )
     insert into rag_eval_cases (
       dataset_id,
       user_id,
       question,
       expected_answer,
       expected_keywords,
       expected_source_files
     )
     select id, user_id, $3, $4, $5, $6
     from scoped_dataset
     where case_count < $7
     returning ${caseColumns}`,
    [
      input.datasetId,
      input.userId,
      input.question,
      input.expectedAnswer || '',
      input.expectedKeywords || [],
      input.expectedSourceFiles || [],
      input.maxCases || 50,
    ]
  );
  return rows[0] || null;
};

export const deleteRagEvalCaseForUser = async (caseId: string, userId: string) => {
  const { rowCount } = await query(
    `delete from rag_eval_cases
     where id = $1 and user_id = $2`,
    [caseId, userId]
  );
  return (rowCount ?? 0) > 0;
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

  return { ...run, results };
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

  const latestRun = recentRuns[0];
  const previousRun = recentRuns[1];
  const trend = recentRuns
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
      duration_ms: run.duration_ms,
      created_at: run.created_at,
      completed_at: run.completed_at,
    }));

  const lowScoreCases = latestRun
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
         latency_ms,
         evidence_label,
         error_message
       from rag_eval_results
       where run_id = $1
       order by overall_score asc, retrieval_score asc, answer_score asc, created_at asc
       limit 5`,
      [latestRun.id]
    )).rows
    : [];

  return {
    dataset_id: datasetId,
    run_count: recentRuns.length,
    latest_run_id: latestRun?.id || null,
    trend_delta: latestRun && previousRun
      ? latestRun.average_overall_score - previousRun.average_overall_score
      : null,
    average_overall_score: latestRun?.average_overall_score || 0,
    average_retrieval_score: latestRun?.average_retrieval_score || 0,
    average_answer_score: latestRun?.average_answer_score || 0,
    average_source_score: latestRun?.average_source_score || 0,
    average_source_recall_score: latestRun?.average_source_recall_score || 0,
    average_source_precision_score: latestRun?.average_source_precision_score || 0,
    average_citation_accuracy_score: latestRun?.average_citation_accuracy_score || 0,
    average_keyword_score: latestRun?.average_keyword_score || 0,
    average_answer_keyword_score: latestRun?.average_answer_keyword_score || 0,
    average_grounding_score: latestRun?.average_grounding_score || 0,
    average_judge_score: latestRun?.average_judge_score || 0,
    trend,
    low_score_cases: lowScoreCases,
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
  const { rows } = await query<RagEvalRunRow>(
    `insert into rag_eval_runs (
       dataset_id,
       user_id,
       status,
       case_count,
       max_attempts
     )
     values ($1, $2, 'running', $3, $4)
     on conflict (dataset_id) where status = 'running' do nothing
     returning ${runColumns}`,
    [input.datasetId, input.userId, input.caseCount, serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS]
  );

  if (rows[0]) {
    await query(
      `update rag_eval_datasets
       set updated_at = now()
       where id = $1 and user_id = $2`,
      [input.datasetId, input.userId]
    );

    return { ...rows[0], results: [], created: true };
  }

  const { rows: runningRows } = await query<RagEvalRunRow>(
    `select ${runColumns}
     from rag_eval_runs
     where dataset_id = $1 and user_id = $2 and status = 'running'
     order by created_at desc
     limit 1`,
    [input.datasetId, input.userId]
  );

  if (!runningRows[0]) {
    throw new Error('Unable to create or locate running RAG eval run');
  }

  return { ...runningRows[0], results: [], created: false };
};

export const claimNextRagEvalRunJob = async (input: {
  workerId: string;
  retryBaseDelayMs?: number;
  staleAfterMs?: number;
  maxAttempts?: number;
}): Promise<ClaimedRagEvalRunJob | null> => {
  const retryBaseDelayMs = input.retryBaseDelayMs ?? serverEnv.RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS;
  const staleAfterMs = input.staleAfterMs ?? serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS;
  const maxAttempts = input.maxAttempts ?? serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS;

  return withTransaction(async (client) => {
    const { rows: runRows } = await client.query<RagEvalRunRow>(
      `with next_run as (
         select id
         from rag_eval_runs
         where status = 'running'
           and attempts < greatest(max_attempts, $3)
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
               and claimed_at <= now() - ($2::double precision * interval '1 millisecond')
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
           attempts = least(greatest(max_attempts, $3), attempts + 1),
           max_attempts = greatest(max_attempts, $3),
           next_attempt_at = null,
           last_error = '',
           queued_at = coalesce(queued_at, created_at)
       where id in (select id from next_run)
       returning ${runColumns}`,
      [retryBaseDelayMs, staleAfterMs, maxAttempts, input.workerId]
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
      `select ${caseColumns}
       from rag_eval_cases
       where dataset_id = $1 and user_id = $2
       order by created_at asc`,
      [run.dataset_id, run.user_id]
    );

    return {
      ...run,
      dataset: {
        ...dataset,
        cases,
      },
    };
  });
};

export const resetStaleRagEvalRunJobs = async (staleAfterMs: number) => {
  const { rowCount } = await query(
    `update rag_eval_runs
     set claimed_at = null,
         worker_id = null,
         next_attempt_at = now(),
         last_error = case
           when last_error = '' then 'RAG eval worker claim expired'
           else last_error
         end
     where status = 'running'
       and claimed_at is not null
       and claimed_at <= now() - ($1::double precision * interval '1 millisecond')
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
         next_attempt_at = null,
         last_error = case
           when last_error = '' then 'RAG eval run exceeded stale timeout'
           else last_error
         end,
         completed_at = now()
     where status = 'running'
       and created_at < now() - ($1::text || ' milliseconds')::interval
       and attempts >= max_attempts`,
    [staleAfterMs]
  );

  return rowCount ?? 0;
};

export const completeRagEvalRunWithResults = async (input: {
  userId: string;
  runId: string;
  workerId?: string | null;
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
           duration_ms = $17,
           claimed_at = null,
           worker_id = null,
           next_attempt_at = null,
           last_error = '',
           completed_at = now()
       where id = $1
         and user_id = $2
         and status in ('running')
         and ($18::text is null or worker_id = $18)
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
        input.output.average_answer_keyword_score ?? input.output.average_keyword_score,
        input.output.average_grounding_score ?? 0,
        input.output.average_judge_score ?? 0,
        input.output.duration_ms,
        input.workerId || null,
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
           latency_ms,
           evidence_label,
           matched_sources,
           trace_summary,
           error_message
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
          result.answer_keyword_score ?? result.keyword_score,
          result.grounding_score ?? 0,
          result.judge_score ?? 0,
          result.latency_ms ?? 0,
          result.evidence_label,
          JSON.stringify(result.matched_sources || []),
          JSON.stringify(result.trace_summary || {}),
          result.error_message || '',
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
}) => {
  const { rows } = await query<RagEvalRunRow>(
    `update rag_eval_runs
     set status = 'failed',
         failed_count = case_count,
         duration_ms = $3,
         claimed_at = null,
         worker_id = null,
         next_attempt_at = null,
         last_error = $4,
         completed_at = now()
     where id = $1 and user_id = $2 and status in ('running')
     returning ${runColumns}`,
    [input.runId, input.userId, input.durationMs || 0, input.errorMessage]
  );

  if (!rows[0]) return null;

  console.error('RAG eval run failed:', {
    run_id: input.runId,
    error: input.errorMessage,
  });

  return { ...rows[0], results: [] };
};

export const markRagEvalRunAttemptFailed = async (input: {
  run: Pick<RagEvalRunRow, 'id' | 'user_id' | 'attempts' | 'max_attempts'>;
  errorMessage: string;
  durationMs?: number;
  workerId?: string | null;
}) => {
  const maxAttempts = Math.max(
    input.run.max_attempts || 0,
    serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS
  );
  const attempts = input.run.attempts || 1;
  const exhausted = attempts >= maxAttempts;
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
       and ($8::text is null or worker_id = $8)
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
      input.workerId || null,
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
         next_attempt_at = null,
         completed_at = now()
     where id = $1 and user_id = $2 and status = 'running'
     returning ${runColumns}`,
    [runId, userId]
  );

  return rows[0] ? { ...rows[0], results: [] } : null;
};

export const insertRagEvalRunWithResults = async (input: {
  userId: string;
  datasetId: string;
  output: RagEvalRunOutput;
}) => {
  return withTransaction(async (client) => {
    const runStatus = getRunStatusFromOutput(input.output);

    const { rows: runRows } = await client.query<RagEvalRunRow>(
      `insert into rag_eval_runs (
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
         duration_ms,
         completed_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
       returning ${runColumns}`,
      [
        input.datasetId,
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
        input.output.average_answer_keyword_score ?? input.output.average_keyword_score,
        input.output.average_grounding_score ?? 0,
        input.output.average_judge_score ?? 0,
        input.output.duration_ms,
      ]
    );

    const run = runRows[0];
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
           latency_ms,
           evidence_label,
           matched_sources,
           trace_summary,
           error_message
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
          result.answer_keyword_score ?? result.keyword_score,
          result.grounding_score ?? 0,
          result.judge_score ?? 0,
          result.latency_ms ?? 0,
          result.evidence_label,
          JSON.stringify(result.matched_sources || []),
          JSON.stringify(result.trace_summary || {}),
          result.error_message || '',
        ]
      );
      resultRows.push(rows[0]);
    }

    await client.query(
      `update rag_eval_datasets
       set updated_at = now()
       where id = $1 and user_id = $2`,
      [input.datasetId, input.userId]
    );

    return { ...run, results: resultRows };
  });
};

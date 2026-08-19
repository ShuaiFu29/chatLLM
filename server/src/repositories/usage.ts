import { ChatSource, RagQualitySummary, RagTraceStep } from '../lib/chatSources';
import { query } from '../lib/db';

export interface UsageSummary {
  totalWorkspaces: number;
  totalConversations: number;
  totalMessages: number;
  totalUserMessages: number;
  totalAssistantMessages: number;
  totalDocuments: number;
  completedDocuments: number;
  failedDocuments: number;
  totalCitations: number;
  estimatedTokens: number;
  agentRunCount: number;
  agentPromptTokens: number;
  agentCompletionTokens: number;
  agentTotalTokens: number;
  modelUsage: UsageModelUsage[];
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

export interface UsageModelUsage {
  model: string;
  conversationCount: number;
  messageCount: number;
  estimatedTokens: number;
}

export interface UsageConversation {
  id: string;
  title: string;
  project_space_id?: string | null;
  project_space_name?: string | null;
  model?: string | null;
  enable_rag: boolean;
  created_at: string;
  updated_at: string;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  source_count: number;
  first_message_at?: string | null;
  last_message_at?: string | null;
}

export interface UsageConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content_preview: string;
  content_length: number;
  source_count: number;
  source_filenames: string[];
  created_at: string;
}

export interface UsageRagRun {
  id: string;
  assistant_message_id?: string | null;
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

export interface UsageFileQueueSummary {
  total: number;
  uploading: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  retryableFailed: number;
  nextRetryAt: string | null;
}

export interface UsageFileQueueItem {
  id: string;
  project_space_id?: string | null;
  filename: string;
  status: 'uploading' | 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  ingestion_status?: string | null;
  ingestion_stage?: string | null;
  ingestion_progress?: number | null;
  total_chunks?: number;
  indexed_chunks?: number;
  keyword_batches?: number;
  graph_batches?: number;
  vector_batches?: number;
  checkpoint?: Record<string, unknown>;
  heartbeat_at?: string | null;
  job_error_message?: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  last_attempt_at?: string | null;
  error_message?: string | null;
  updated_at: string;
}

export interface UsageFileQueue {
  summary: UsageFileQueueSummary;
  files: UsageFileQueueItem[];
}

interface UsageSummaryRow {
  total_workspaces: number | string | null;
  total_conversations: number | string | null;
  total_messages: number | string | null;
  total_user_messages: number | string | null;
  total_assistant_messages: number | string | null;
  total_documents: number | string | null;
  completed_documents: number | string | null;
  failed_documents: number | string | null;
  total_citations: number | string | null;
  estimated_tokens: number | string | null;
  agent_run_count: number | string | null;
  agent_prompt_tokens: number | string | null;
  agent_completion_tokens: number | string | null;
  agent_total_tokens: number | string | null;
  first_message_at: string | null;
  last_message_at: string | null;
}

interface UsageModelUsageRow {
  model: string | null;
  conversation_count: number | string | null;
  message_count: number | string | null;
  estimated_tokens: number | string | null;
}

interface UsageConversationRow extends Omit<UsageConversation, 'message_count' | 'user_message_count' | 'assistant_message_count' | 'source_count'> {
  message_count: number | string | null;
  user_message_count: number | string | null;
  assistant_message_count: number | string | null;
  source_count: number | string | null;
}

interface UsageConversationMessageRow extends Omit<UsageConversationMessage, 'content_length' | 'source_count' | 'source_filenames'> {
  content_length: number | string | null;
  source_count: number | string | null;
  source_filenames: string[] | null;
}

interface UsageRagRunRow extends Omit<UsageRagRun, 'planned_queries' | 'trace_steps' | 'quality' | 'retrieved_sources'> {
  planned_queries: string[] | string | null;
  trace_steps: RagTraceStep[] | string | null;
  quality: Partial<RagQualitySummary> | string | null;
  retrieved_sources: ChatSource[] | string | null;
}

interface UsageFileQueueSummaryRow {
  total: number | string | null;
  uploading: number | string | null;
  pending: number | string | null;
  processing: number | string | null;
  completed: number | string | null;
  failed: number | string | null;
  retryable_failed: number | string | null;
  next_retry_at: string | null;
}

interface UsageFileQueueItemRow extends Omit<
  UsageFileQueueItem,
  | 'progress'
  | 'attempts'
  | 'max_attempts'
  | 'ingestion_progress'
  | 'total_chunks'
  | 'indexed_chunks'
  | 'keyword_batches'
  | 'graph_batches'
  | 'vector_batches'
  | 'checkpoint'
> {
  progress: number | string | null;
  ingestion_progress: number | string | null;
  total_chunks: number | string | null;
  indexed_chunks: number | string | null;
  keyword_batches: number | string | null;
  graph_batches: number | string | null;
  vector_batches: number | string | null;
  checkpoint: Record<string, unknown> | string | null;
  attempts: number | string | null;
  max_attempts: number | string | null;
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

const mapUsageConversation = (row: UsageConversationRow): UsageConversation => ({
  ...row,
  message_count: toCount(row.message_count),
  user_message_count: toCount(row.user_message_count),
  assistant_message_count: toCount(row.assistant_message_count),
  source_count: toCount(row.source_count),
});

const mapUsageMessage = (row: UsageConversationMessageRow): UsageConversationMessage => ({
  ...row,
  content_length: toCount(row.content_length),
  source_count: toCount(row.source_count),
  source_filenames: row.source_filenames || [],
});

const mapUsageRagRun = (row: UsageRagRunRow): UsageRagRun => ({
  ...row,
  planned_queries: toJsonArray<string>(row.planned_queries),
  trace_steps: toJsonArray<RagTraceStep>(row.trace_steps),
  quality: toJsonObject<Partial<RagQualitySummary>>(row.quality),
  retrieved_sources: toJsonArray<ChatSource>(row.retrieved_sources),
});

const mapUsageFileQueueItem = (row: UsageFileQueueItemRow): UsageFileQueueItem => ({
  ...row,
  progress: toCount(row.progress),
  ingestion_progress: row.ingestion_progress === null || row.ingestion_progress === undefined
    ? null
    : toCount(row.ingestion_progress),
  total_chunks: toCount(row.total_chunks),
  indexed_chunks: toCount(row.indexed_chunks),
  keyword_batches: toCount(row.keyword_batches),
  graph_batches: toCount(row.graph_batches),
  vector_batches: toCount(row.vector_batches),
  checkpoint: toJsonObject<Record<string, unknown>>(row.checkpoint),
  attempts: toCount(row.attempts),
  max_attempts: toCount(row.max_attempts),
});

export const getUsageSummaryForUser = async (userId: string): Promise<UsageSummary> => {
  const { rows } = await query<UsageSummaryRow>(
    `with message_counts as (
       select
         c.user_id,
         count(m.id)::int as total_messages,
         count(m.id) filter (where m.role = 'user')::int as total_user_messages,
         count(m.id) filter (where m.role = 'assistant')::int as total_assistant_messages,
         coalesce(sum(jsonb_array_length(coalesce(m.sources, '[]'::jsonb))) filter (where m.role = 'assistant'), 0)::int as total_citations,
         coalesce(sum(ceil(char_length(m.content) / 4.0)), 0)::int as estimated_tokens,
         min(m.created_at) as first_message_at,
         max(m.created_at) as last_message_at
       from conversations c
       left join messages m on m.conversation_id = c.id
       where c.user_id = $1
       group by c.user_id
     ), agent_usage as (
       select
         count(*)::int as agent_run_count,
         coalesce(sum(case when token_usage ->> 'prompt_tokens' ~ '^[0-9]+$' then (token_usage ->> 'prompt_tokens')::bigint else 0 end), 0)::bigint as agent_prompt_tokens,
         coalesce(sum(case when token_usage ->> 'completion_tokens' ~ '^[0-9]+$' then (token_usage ->> 'completion_tokens')::bigint else 0 end), 0)::bigint as agent_completion_tokens,
         coalesce(sum(case when token_usage ->> 'total_tokens' ~ '^[0-9]+$' then (token_usage ->> 'total_tokens')::bigint else 0 end), 0)::bigint as agent_total_tokens
       from agent_runs
       where user_id = $1
     )
     select
       (select count(*)::int from project_spaces
        where user_id = $1) as total_workspaces,
       (select count(*)::int from conversations
        where user_id = $1) as total_conversations,
       coalesce(message_counts.total_messages, 0)::int as total_messages,
       coalesce(message_counts.total_user_messages, 0)::int as total_user_messages,
       coalesce(message_counts.total_assistant_messages, 0)::int as total_assistant_messages,
       (select count(*)::int from files
        where user_id = $1) as total_documents,
       (select count(*)::int from files
        where user_id = $1 and status = 'completed') as completed_documents,
       (select count(*)::int from files
        where user_id = $1 and status = 'failed') as failed_documents,
       coalesce(message_counts.total_citations, 0)::int as total_citations,
       coalesce(message_counts.estimated_tokens, 0)::int as estimated_tokens,
       coalesce(agent_usage.agent_run_count, 0)::int as agent_run_count,
       coalesce(agent_usage.agent_prompt_tokens, 0)::bigint as agent_prompt_tokens,
       coalesce(agent_usage.agent_completion_tokens, 0)::bigint as agent_completion_tokens,
       coalesce(agent_usage.agent_total_tokens, 0)::bigint as agent_total_tokens,
       message_counts.first_message_at,
       message_counts.last_message_at
     from (select $1::uuid as user_id) usage_scope
     left join message_counts on message_counts.user_id = usage_scope.user_id
     cross join agent_usage`,
    [userId]
  );

  const row = rows[0];
  const agentTotalTokens = toCount(row?.agent_total_tokens);
  const { rows: modelRows } = await query<UsageModelUsageRow>(
    `select
       coalesce(c.model, 'deepseek-chat') as model,
       count(distinct c.id)::int as conversation_count,
       count(m.id)::int as message_count,
       coalesce(sum(ceil(char_length(m.content) / 4.0)), 0)::int as estimated_tokens
     from conversations c
     left join messages m on m.conversation_id = c.id
     where c.user_id = $1
     group by coalesce(c.model, 'deepseek-chat')
     order by estimated_tokens desc, conversation_count desc`,
    [userId]
  );

  return {
    totalWorkspaces: toCount(row?.total_workspaces),
    totalConversations: toCount(row?.total_conversations),
    totalMessages: toCount(row?.total_messages),
    totalUserMessages: toCount(row?.total_user_messages),
    totalAssistantMessages: toCount(row?.total_assistant_messages),
    totalDocuments: toCount(row?.total_documents),
    completedDocuments: toCount(row?.completed_documents),
    failedDocuments: toCount(row?.failed_documents),
    totalCitations: toCount(row?.total_citations),
    estimatedTokens: toCount(row?.estimated_tokens) + agentTotalTokens,
    agentRunCount: toCount(row?.agent_run_count),
    agentPromptTokens: toCount(row?.agent_prompt_tokens),
    agentCompletionTokens: toCount(row?.agent_completion_tokens),
    agentTotalTokens,
    modelUsage: modelRows.map((modelRow) => ({
      model: modelRow.model || 'deepseek-chat',
      conversationCount: toCount(modelRow.conversation_count),
      messageCount: toCount(modelRow.message_count),
      estimatedTokens: toCount(modelRow.estimated_tokens),
    })),
    firstMessageAt: row?.first_message_at || null,
    lastMessageAt: row?.last_message_at || null,
  };
};

export const listUsageConversationsForUser = async (userId: string, limit = 100): Promise<UsageConversation[]> => {
  const { rows } = await query<UsageConversationRow>(
    `select
       c.id,
       c.title,
       c.project_space_id,
       ps.name as project_space_name,
       c.model,
       c.enable_rag,
       c.created_at,
       c.updated_at,
       count(m.id)::int as message_count,
       count(m.id) filter (where m.role = 'user')::int as user_message_count,
       count(m.id) filter (where m.role = 'assistant')::int as assistant_message_count,
       coalesce(sum(jsonb_array_length(coalesce(m.sources, '[]'::jsonb))) filter (where m.role = 'assistant'), 0)::int as source_count,
       min(m.created_at) as first_message_at,
       max(m.created_at) as last_message_at
     from conversations c
     left join project_spaces ps on ps.id = c.project_space_id and ps.user_id = c.user_id
     left join messages m on m.conversation_id = c.id
     where c.user_id = $1
     group by c.id, ps.name
     order by c.updated_at desc
     limit $2`,
    [userId, limit]
  );

  return rows.map(mapUsageConversation);
};

export const findUsageConversationForUser = async (
  conversationId: string,
  userId: string
): Promise<UsageConversation | null> => {
  const { rows } = await query<UsageConversationRow>(
    `select
       c.id,
       c.title,
       c.project_space_id,
       ps.name as project_space_name,
       c.model,
       c.enable_rag,
       c.created_at,
       c.updated_at,
       count(m.id)::int as message_count,
       count(m.id) filter (where m.role = 'user')::int as user_message_count,
       count(m.id) filter (where m.role = 'assistant')::int as assistant_message_count,
       coalesce(sum(jsonb_array_length(coalesce(m.sources, '[]'::jsonb))) filter (where m.role = 'assistant'), 0)::int as source_count,
       min(m.created_at) as first_message_at,
       max(m.created_at) as last_message_at
     from conversations c
     left join project_spaces ps on ps.id = c.project_space_id and ps.user_id = c.user_id
     left join messages m on m.conversation_id = c.id
     where c.id = $1 and c.user_id = $2
     group by c.id, ps.name`,
    [conversationId, userId]
  );

  return rows[0] ? mapUsageConversation(rows[0]) : null;
};

export const listUsageConversationMessagesForUser = async (
  conversationId: string,
  userId: string,
  limit = 500
): Promise<UsageConversationMessage[]> => {
  const { rows } = await query<UsageConversationMessageRow>(
    `select
       m.id,
       m.role,
       left(m.content, 320) as content_preview,
       char_length(m.content)::int as content_length,
       jsonb_array_length(coalesce(m.sources, '[]'::jsonb))::int as source_count,
       coalesce((
         select jsonb_agg(distinct source_item.value->>'filename')
         from jsonb_array_elements(coalesce(m.sources, '[]'::jsonb)) as source_item(value)
         where source_item.value ? 'filename'
       ), '[]'::jsonb) as source_filenames,
       m.created_at
     from messages m
     join conversations c on c.id = m.conversation_id
     where m.conversation_id = $1 and c.user_id = $2
     order by m.created_at asc
     limit $3`,
    [conversationId, userId, limit]
  );

  return rows.map(mapUsageMessage);
};

export const listUsageRagRunsForConversation = async (
  conversationId: string,
  userId: string,
  limit = 50
): Promise<UsageRagRun[]> => {
  const { rows } = await query<UsageRagRunRow>(
    `select
       rr.id,
       rr.assistant_message_id,
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
     where rr.conversation_id = $1 and c.user_id = $2
     order by rr.created_at desc
     limit $3`,
    [conversationId, userId, limit]
  );

  return rows.map(mapUsageRagRun);
};

export const getFileQueueSummaryForUser = async (userId: string, limit = 25): Promise<UsageFileQueue> => {
  const { rows: summaryRows } = await query<UsageFileQueueSummaryRow>(
    `select
       count(*)::int as total,
       count(*) filter (where status = 'uploading')::int as uploading,
       count(*) filter (where status = 'pending')::int as pending,
       count(*) filter (where status = 'processing')::int as processing,
       count(*) filter (where status = 'completed')::int as completed,
       count(*) filter (where status = 'failed')::int as failed,
       count(*) filter (where status = 'failed' and attempts < max_attempts and next_attempt_at is not null)::int as retryable_failed,
       min(next_attempt_at) filter (where status = 'failed' and attempts < max_attempts and next_attempt_at is not null) as next_retry_at
     from files
     where user_id = $1`,
    [userId]
  );

  const { rows: fileRows } = await query<UsageFileQueueItemRow>(
    `select
       files.id,
       files.project_space_id,
       files.filename,
       files.status,
       files.progress,
       file_ingestion_jobs.status as ingestion_status,
       file_ingestion_jobs.stage as ingestion_stage,
       file_ingestion_jobs.progress as ingestion_progress,
       file_ingestion_jobs.total_chunks,
       file_ingestion_jobs.indexed_chunks,
       file_ingestion_jobs.keyword_batches,
       file_ingestion_jobs.graph_batches,
       file_ingestion_jobs.vector_batches,
       file_ingestion_jobs.checkpoint,
       file_ingestion_jobs.heartbeat_at,
       file_ingestion_jobs.error_message as job_error_message,
       files.attempts,
       files.max_attempts,
       files.next_attempt_at,
       files.last_attempt_at,
       files.error_message,
       files.updated_at
     from files
     left join file_ingestion_jobs on file_ingestion_jobs.file_id = files.id
     where files.user_id = $1
     order by greatest(files.updated_at, coalesce(file_ingestion_jobs.updated_at, files.updated_at)) desc
     limit $2`,
    [userId, limit]
  );

  const summary = summaryRows[0];

  return {
    summary: {
      total: toCount(summary?.total),
      uploading: toCount(summary?.uploading),
      pending: toCount(summary?.pending),
      processing: toCount(summary?.processing),
      completed: toCount(summary?.completed),
      failed: toCount(summary?.failed),
      retryableFailed: toCount(summary?.retryable_failed),
      nextRetryAt: summary?.next_retry_at || null,
    },
    files: fileRows.map(mapUsageFileQueueItem),
  };
};

import { query, withTransaction } from '../lib/db';
import { ChatSource, RagTraceSummary } from '../lib/chatSources';
import { encodeMessageCursor, MessageCursor } from '../lib/messagePagination';

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources: ChatSource[];
  rag_run_id?: string | null;
  rag_trace?: RagTraceSummary | null;
  created_at: string;
}

export interface SearchMessageFilters {
  projectSpaceId?: string;
  hasSources?: boolean;
  model?: string;
  favoriteOnly?: boolean;
  tag?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface MessagePageOptions {
  limit: number;
  cursor?: MessageCursor | null;
}

export interface MessagePage {
  messages: MessageRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export const insertMessage = async (
  conversationId: string,
  role: MessageRow['role'],
  content: string,
  sources: ChatSource[] = []
) => {
  const { rows } = await query<MessageRow>(
    `insert into messages (conversation_id, role, content, sources)
     values ($1, $2, $3, $4)
     returning id, conversation_id, role, content, sources, rag_run_id, null::jsonb as rag_trace, created_at`,
    [conversationId, role, content, JSON.stringify(sources)]
  );
  return rows[0];
};

export const listMessagesForConversation = async (conversationId: string) => {
  const { rows } = await query<MessageRow>(
    `select
       m.id,
       m.conversation_id,
       m.role,
       m.content,
       m.sources,
       m.rag_run_id,
       case when rr.id is null then null else jsonb_build_object(
         'mode', rr.mode,
         'planned_queries', rr.planned_queries,
         'trace_steps', rr.trace_steps,
         'quality', rr.quality
       ) end as rag_trace,
       m.created_at
     from messages m
     left join rag_runs rr on rr.id = m.rag_run_id
     where m.conversation_id = $1
     order by m.created_at asc`,
    [conversationId]
  );
  return rows;
};

export const listRecentMessages = async (conversationId: string, limit = 10) => {
  const { rows } = await query<Pick<MessageRow, 'role' | 'content'>>(
    `select role, content
     from messages
     where conversation_id = $1
     order by created_at desc
     limit $2`,
    [conversationId, limit]
  );
  return rows;
};

export const searchMessagesForUser = async (userId: string, search: string, filters: SearchMessageFilters = {}) => {
  const values: unknown[] = [userId, `%${search}%`];
  const conditions = ['c.user_id = $1', 'm.content ilike $2'];

  if (filters.projectSpaceId) {
    values.push(filters.projectSpaceId);
    conditions.push(`c.project_space_id = $${values.length}`);
  }

  if (filters.hasSources) {
    conditions.push(`jsonb_array_length(coalesce(m.sources, '[]'::jsonb)) > 0`);
  }

  if (filters.model) {
    values.push(filters.model);
    conditions.push(`c.model = $${values.length}`);
  }

  if (filters.favoriteOnly) {
    conditions.push('c.is_favorite = true');
  }

  if (filters.tag) {
    values.push(filters.tag);
    conditions.push(`$${values.length} = any(c.tags)`);
  }

  if (!filters.includeArchived) {
    conditions.push('c.archived_at is null');
  }

  const boundedLimit = Math.min(Math.max(filters.limit || 20, 1), 50);
  values.push(boundedLimit);

  const { rows } = await query(
    `select
       m.id,
       m.content,
       m.sources,
       m.rag_run_id,
       case when rr.id is null then null else jsonb_build_object(
         'mode', rr.mode,
         'planned_queries', rr.planned_queries,
         'trace_steps', rr.trace_steps,
         'quality', rr.quality
       ) end as rag_trace,
       m.created_at,
       m.conversation_id,
       json_build_object(
         'id', c.id,
         'title', c.title,
         'user_id', c.user_id,
         'project_space_id', c.project_space_id,
         'is_favorite', c.is_favorite,
         'tags', c.tags,
         'archived_at', c.archived_at
       ) as conversations
     from messages m
     join conversations c on c.id = m.conversation_id
     left join rag_runs rr on rr.id = m.rag_run_id
     where ${conditions.join(' and ')}
     order by m.created_at desc
     limit $${values.length}`,
    values
  );
  return rows;
};

export const listMessagesForConversationPage = async (
  conversationId: string,
  options: MessagePageOptions
): Promise<MessagePage> => {
  const values: unknown[] = [conversationId];
  let cursorFilter = '';

  if (options.cursor) {
    values.push(options.cursor.createdAt, options.cursor.id);
    cursorFilter = `and (m.created_at, m.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
  }

  values.push(options.limit + 1);

  const { rows } = await query<MessageRow>(
    `select
       m.id,
       m.conversation_id,
       m.role,
       m.content,
       m.sources,
       m.rag_run_id,
       case when rr.id is null then null else jsonb_build_object(
         'mode', rr.mode,
         'planned_queries', rr.planned_queries,
         'trace_steps', rr.trace_steps,
         'quality', rr.quality
       ) end as rag_trace,
       m.created_at
     from messages m
     left join rag_runs rr on rr.id = m.rag_run_id
     where m.conversation_id = $1
       ${cursorFilter}
     order by m.created_at desc, m.id desc
     limit $${values.length}`,
    values
  );

  const hasMore = rows.length > options.limit;
  const messages = rows.slice(0, options.limit).reverse();
  const oldestMessage = messages[0];

  return {
    messages,
    hasMore,
    nextCursor: hasMore && oldestMessage ? encodeMessageCursor(oldestMessage) : null,
  };
};

export const deleteMessageForUser = async (messageId: string, userId: string) => {
  const { rows } = await query<{ id: string }>(
    `delete from messages m
     using conversations c
     where m.conversation_id = c.id
       and m.id = $1
       and c.user_id = $2
     returning m.id`,
    [messageId, userId]
  );
  return rows.length > 0;
};

export const truncateConversationFromUserMessage = async (
  conversationId: string,
  messageId: string,
  userId: string,
  runInTransaction: typeof withTransaction = withTransaction
) => runInTransaction(async (client) => {
  const { rows: conversationRows } = await client.query<{ id: string }>(
    `select id
     from conversations
     where id = $1 and user_id = $2
     for update`,
    [conversationId, userId]
  );
  if (!conversationRows[0]) return null;

  const { rows: messageRows } = await client.query<Pick<MessageRow, 'id' | 'created_at'>>(
    `select id, created_at
     from messages
     where id = $1
       and conversation_id = $2
       and role = 'user'
     for update`,
    [messageId, conversationId]
  );
  const selectedMessage = messageRows[0];
  if (!selectedMessage) return null;

  const { rowCount } = await client.query(
    `delete from messages
     where conversation_id = $1
       and created_at >= $2`,
    [conversationId, selectedMessage.created_at]
  );
  return { deletedCount: rowCount ?? 0 };
});

import { query } from '../lib/db';
import { ChatSource } from '../lib/chatSources';

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources: ChatSource[];
  created_at: string;
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
     returning id, conversation_id, role, content, sources, created_at`,
    [conversationId, role, content, JSON.stringify(sources)]
  );
  return rows[0];
};

export const listMessagesForConversation = async (conversationId: string) => {
  const { rows } = await query<MessageRow>(
    `select id, conversation_id, role, content, sources, created_at
     from messages
     where conversation_id = $1
     order by created_at asc`,
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

export const searchMessagesForUser = async (userId: string, search: string) => {
  const { rows } = await query(
    `select
       m.id,
       m.content,
       m.sources,
       m.created_at,
       m.conversation_id,
       json_build_object(
         'id', c.id,
         'title', c.title,
         'user_id', c.user_id,
         'project_space_id', c.project_space_id
       ) as conversations
     from messages m
     join conversations c on c.id = m.conversation_id
     where c.user_id = $1 and m.content ilike $2
     order by m.created_at desc
     limit 20`,
    [userId, `%${search}%`]
  );
  return rows;
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

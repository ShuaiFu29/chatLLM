import { query } from '../lib/db';

export interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  model?: string | null;
  temperature?: number | null;
  system_prompt?: string | null;
  enable_rag: boolean;
  created_at: string;
  updated_at: string;
}

const columns = `
  id,
  user_id,
  title,
  model,
  temperature,
  system_prompt,
  enable_rag,
  created_at,
  updated_at
`;

export const listConversations = async (userId: string) => {
  const { rows } = await query<ConversationRow>(
    `select ${columns}
     from conversations
     where user_id = $1
     order by updated_at desc`,
    [userId]
  );
  return rows;
};

export const createConversationForUser = async (userId: string, title = 'New Chat') => {
  const { rows } = await query<ConversationRow>(
    `insert into conversations (user_id, title)
     values ($1, $2)
     returning ${columns}`,
    [userId, title]
  );
  return rows[0];
};

export const findConversationForUser = async (conversationId: string, userId: string) => {
  const { rows } = await query<ConversationRow>(
    `select ${columns}
     from conversations
     where id = $1 and user_id = $2`,
    [conversationId, userId]
  );
  return rows[0] || null;
};

export const updateConversationForUser = async (
  conversationId: string,
  userId: string,
  updates: Partial<Pick<ConversationRow, 'title' | 'model' | 'temperature' | 'system_prompt' | 'enable_rag'>>
) => {
  const fields: string[] = ['updated_at = now()'];
  const values: unknown[] = [];

  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined) {
      values.push(value);
      fields.push(`${key} = $${values.length}`);
    }
  });

  values.push(conversationId, userId);

  const { rows } = await query<ConversationRow>(
    `update conversations
     set ${fields.join(', ')}
     where id = $${values.length - 1} and user_id = $${values.length}
     returning ${columns}`,
    values
  );

  return rows[0] || null;
};

export const updateConversationTitle = async (conversationId: string, title: string) => {
  await query(
    `update conversations
     set title = $1, updated_at = now()
     where id = $2`,
    [title, conversationId]
  );
};

export const touchConversation = async (conversationId: string, userId: string) => {
  await query(
    `update conversations
     set updated_at = now()
     where id = $1 and user_id = $2`,
    [conversationId, userId]
  );
};

export const deleteConversationForUser = async (conversationId: string, userId: string) => {
  const { rowCount } = await query(
    `delete from conversations
     where id = $1 and user_id = $2`,
    [conversationId, userId]
  );
  return (rowCount ?? 0) > 0;
};

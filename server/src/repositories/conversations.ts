import { query, withTransaction } from '../lib/db';
import { MessageRow } from './messages';

export interface ConversationRow {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  title: string;
  model?: string | null;
  temperature?: number | null;
  system_prompt?: string | null;
  enable_rag: boolean;
  is_pinned: boolean;
  archived_at?: string | null;
  parent_conversation_id?: string | null;
  branched_from_message_id?: string | null;
  branch_name: string;
  is_favorite: boolean;
  tags: string[];
  note: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationListOptions {
  projectSpaceId?: string;
  includeArchived?: boolean;
}

const columns = `
  id,
  user_id,
  project_space_id,
  title,
  model,
  temperature,
  system_prompt,
  enable_rag,
  is_pinned,
  archived_at,
  parent_conversation_id,
  branched_from_message_id,
  branch_name,
  is_favorite,
  tags,
  note,
  created_at,
  updated_at
`;

export const listConversations = async (userId: string, options: ConversationListOptions = {}) => {
  const values: unknown[] = [userId];
  let projectSpaceFilter = '';
  let archivedFilter = 'and archived_at is null';

  if (options.projectSpaceId) {
    values.push(options.projectSpaceId);
    projectSpaceFilter = `and project_space_id = $${values.length}`;
  }

  if (options.includeArchived) {
    archivedFilter = '';
  }

  const { rows } = await query<ConversationRow>(
    `select ${columns}
     from conversations
     where user_id = $1
       ${projectSpaceFilter}
       ${archivedFilter}
     order by is_pinned desc, updated_at desc`,
    values
  );
  return rows;
};

export const createConversationForUser = async (userId: string, title = 'New Chat', projectSpaceId?: string | null) => {
  const { rows } = await query<ConversationRow>(
    `insert into conversations (user_id, project_space_id, title)
     values ($1, $2, $3)
     returning ${columns}`,
    [userId, projectSpaceId || null, title]
  );
  return rows[0];
};

export const createConversationBranchForUser = async (input: {
  userId: string;
  conversationId: string;
  messageId?: string;
  title?: string;
}) => {
  return withTransaction(async (client) => {
    const conversationResult = await client.query<ConversationRow>(
      `select ${columns}
       from conversations
       where id = $1 and user_id = $2`,
      [input.conversationId, input.userId]
    );
    const sourceConversation = conversationResult.rows[0];
    if (!sourceConversation) return null;

    let messageFilter = '';
    const messageValues: unknown[] = [input.conversationId];

    if (input.messageId) {
      const branchMessageResult = await client.query<Pick<MessageRow, 'id' | 'created_at'>>(
        `select m.id, m.created_at
         from messages m
         join conversations c on c.id = m.conversation_id
         where m.id = $1
           and m.conversation_id = $2
           and c.user_id = $3`,
        [input.messageId, input.conversationId, input.userId]
      );

      const branchMessage = branchMessageResult.rows[0];
      if (!branchMessage) return null;

      messageValues.push(branchMessage.created_at);
      messageFilter = 'and created_at <= $3';
    }

    const branchTitle = input.title?.trim()
      || `${sourceConversation.title === 'New Chat' ? 'Branch' : sourceConversation.title} branch`;

    const branchResult = await client.query<ConversationRow>(
      `insert into conversations (
         user_id,
         project_space_id,
         title,
         model,
         temperature,
         system_prompt,
         enable_rag,
         parent_conversation_id,
         branched_from_message_id,
         branch_name,
         tags,
         note
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning ${columns}`,
      [
        input.userId,
        sourceConversation.project_space_id || null,
        branchTitle,
        sourceConversation.model || null,
        sourceConversation.temperature ?? null,
        sourceConversation.system_prompt || null,
        sourceConversation.enable_rag,
        sourceConversation.id,
        input.messageId || null,
        branchTitle,
        sourceConversation.tags || [],
        sourceConversation.note || '',
      ]
    );

    const branchConversation = branchResult.rows[0];

    await client.query(
      `insert into messages (conversation_id, role, content, sources)
       select $1, role, content, sources
       from messages
       where conversation_id = $2
         ${messageFilter}
       order by created_at asc`,
      [branchConversation.id, ...messageValues]
    );

    return branchConversation;
  });
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
  updates: Partial<Pick<ConversationRow, 'title' | 'model' | 'temperature' | 'system_prompt' | 'enable_rag' | 'project_space_id' | 'is_pinned' | 'archived_at' | 'is_favorite' | 'tags' | 'note'>>
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

export const compareConversationsForUser = async (
  userId: string,
  conversationId: string,
  otherConversationId: string
) => {
  const { rows: conversations } = await query<ConversationRow>(
    `select ${columns}
     from conversations
     where user_id = $1
       and id in ($2, $3)`,
    [userId, conversationId, otherConversationId]
  );

  if (conversations.length !== 2) return null;

  const { rows: messages } = await query<MessageRow>(
    `select m.id, m.conversation_id, m.role, m.content, m.sources, m.created_at
     from messages m
     join conversations c on c.id = m.conversation_id
     where c.user_id = $1
       and m.conversation_id in ($2, $3)
     order by m.conversation_id, m.created_at asc`,
    [userId, conversationId, otherConversationId]
  );

  return {
    conversations,
    messagesByConversation: {
      [conversationId]: messages.filter((message) => message.conversation_id === conversationId),
      [otherConversationId]: messages.filter((message) => message.conversation_id === otherConversationId),
    },
  };
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

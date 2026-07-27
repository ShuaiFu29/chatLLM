import { HttpException, Injectable } from '@nestjs/common';
import { httpResponse } from '../../common/http/http-response';
import { normalizeMessagePageQuery } from '../../lib/messagePagination';
import { normalizeSearchQuery, readSearchFilters } from '../../lib/searchInput';
import {
  compareConversationsForUser,
  createConversationBranchForUser,
  createConversationForUser,
  deleteConversationForUser,
  findConversationForUser,
  listConversations,
  updateConversationForUser,
} from '../../repositories/conversations';
import {
  deleteMessageForUser,
  listMessagesForConversationPage,
  searchMessagesForUser,
  truncateConversationFromUserMessage,
} from '../../repositories/messages';
import {
  ensureDefaultProjectSpaceForUser,
  findProjectSpaceForUser,
} from '../../repositories/projectSpaces';
import { User } from '../../types';

type RequestValues = Record<string, any>;

const publicError = (statusCode: number, error: string, cause?: unknown) => (
  new HttpException(
    { error },
    statusCode,
    cause === undefined ? undefined : { cause },
  )
);

const readProjectSpaceId = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const readBooleanQuery = (value: unknown) => {
  if (typeof value !== 'string') return false;
  return value === 'true' || value === '1';
};

const resolveProjectSpaceId = async (userId: string, requestedProjectSpaceId?: string) => {
  if (requestedProjectSpaceId) {
    const space = await findProjectSpaceForUser(requestedProjectSpaceId, userId);
    return space?.id ?? null;
  }

  return (await ensureDefaultProjectSpaceForUser(userId)).id;
};

@Injectable()
export class ChatService {
  async listConversations(user: User, query: RequestValues) {
    try {
      const projectSpaceId = readProjectSpaceId(
        query.projectSpaceId || query.project_space_id,
      );
      const includeArchived = readBooleanQuery(
        query.includeArchived || query.include_archived,
      );
      return await listConversations(user.id, { projectSpaceId, includeArchived });
    } catch (error) {
      throw publicError(500, 'Failed to fetch conversations', error);
    }
  }

  async searchMessages(user: User, query: RequestValues) {
    const normalizedQuery = normalizeSearchQuery(query.q);
    if (!normalizedQuery.ok) {
      throw publicError(normalizedQuery.statusCode, normalizedQuery.error);
    }

    try {
      return await searchMessagesForUser(
        user.id,
        normalizedQuery.query,
        readSearchFilters(query),
      );
    } catch (error) {
      throw publicError(500, 'Failed to search messages', error);
    }
  }

  async createConversation(user: User, body: RequestValues) {
    try {
      const requestedProjectSpaceId = readProjectSpaceId(
        body.project_space_id ?? body.projectSpaceId,
      );
      const projectSpaceId = await resolveProjectSpaceId(user.id, requestedProjectSpaceId);
      if (!projectSpaceId) throw publicError(404, 'Project space not found');

      return await createConversationForUser(
        user.id,
        body.title || 'New Chat',
        projectSpaceId,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(500, 'Failed to create conversation', error);
    }
  }

  async updateConversation(
    user: User,
    conversationId: string,
    body: RequestValues,
  ) {
    const {
      title,
      model,
      temperature,
      system_prompt,
      enable_rag,
      is_pinned,
      archived,
      is_favorite,
      tags,
      note,
    } = body;
    const updates: {
      title?: string;
      model?: string;
      temperature?: number;
      system_prompt?: string;
      enable_rag?: boolean;
      project_space_id?: string | null;
      is_pinned?: boolean;
      archived_at?: string | null;
      is_favorite?: boolean;
      tags?: string[];
      note?: string;
    } = {};

    if (title !== undefined) updates.title = title;
    if (model !== undefined) updates.model = model;
    if (temperature !== undefined) updates.temperature = temperature;
    if (system_prompt !== undefined) updates.system_prompt = system_prompt;
    if (enable_rag !== undefined) updates.enable_rag = enable_rag;
    if (is_pinned !== undefined) updates.is_pinned = is_pinned;
    if (archived !== undefined) {
      updates.archived_at = archived ? new Date().toISOString() : null;
    }
    if (is_favorite !== undefined) updates.is_favorite = is_favorite;
    if (tags !== undefined) updates.tags = tags;
    if (note !== undefined) updates.note = note;

    try {
      if (body.project_space_id !== undefined || body.projectSpaceId !== undefined) {
        const requestedProjectSpaceId = readProjectSpaceId(
          body.project_space_id ?? body.projectSpaceId,
        );
        if (!requestedProjectSpaceId) {
          updates.project_space_id = null;
        } else {
          const space = await findProjectSpaceForUser(requestedProjectSpaceId, user.id);
          if (!space) throw publicError(404, 'Project space not found');
          updates.project_space_id = space.id;
        }
      }

      if (Object.keys(updates).length === 0) {
        throw publicError(400, 'No fields to update');
      }

      const conversation = await updateConversationForUser(
        conversationId,
        user.id,
        updates,
      );
      if (!conversation) throw publicError(404, 'Conversation not found');
      return conversation;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(500, 'Failed to update conversation', error);
    }
  }

  async branchConversation(
    user: User,
    conversationId: string,
    body: RequestValues,
  ) {
    try {
      const conversation = await createConversationBranchForUser({
        userId: user.id,
        conversationId,
        messageId: body.messageId,
        title: body.title,
      });
      if (!conversation) throw publicError(404, 'Conversation or message not found');
      return conversation;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(500, 'Failed to branch conversation', error);
    }
  }

  async compareConversations(
    user: User,
    conversationId: string,
    otherConversationId: string,
  ) {
    try {
      const comparison = await compareConversationsForUser(
        user.id,
        conversationId,
        otherConversationId,
      );
      if (!comparison) throw publicError(404, 'Conversation not found');
      return comparison;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(500, 'Failed to compare conversations', error);
    }
  }

  async deleteConversation(user: User, conversationId: string) {
    try {
      const deleted = await deleteConversationForUser(conversationId, user.id);
      if (!deleted) throw publicError(404, 'Conversation not found');
      return { success: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(500, 'Failed to delete conversation', error);
    }
  }

  async deleteMessage(user: User, messageId: string) {
    try {
      const deleted = await deleteMessageForUser(messageId, user.id);
      if (!deleted) throw publicError(404, 'Message not found');
      return { success: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(500, 'Failed to delete message', error);
    }
  }

  async truncateConversation(
    user: User,
    conversationId: string,
    messageId: string,
  ) {
    try {
      const result = await truncateConversationFromUserMessage(
        conversationId,
        messageId,
        user.id,
      );
      if (!result) throw publicError(404, 'Conversation or user message not found');
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(500, 'Failed to truncate conversation', error);
    }
  }

  async getMessages(user: User, conversationId: string, query: RequestValues) {
    const pageQuery = normalizeMessagePageQuery(query);
    if (!pageQuery.ok) throw publicError(pageQuery.statusCode, pageQuery.error);

    try {
      const conversation = await findConversationForUser(conversationId, user.id);
      if (!conversation) throw publicError(403, 'Forbidden');

      const page = await listMessagesForConversationPage(conversationId, pageQuery);
      return httpResponse(page.messages, {
        headers: {
          'x-chatllm-has-more': String(page.hasMore),
          'x-chatllm-next-cursor': page.nextCursor || '',
          'x-chatllm-page-limit': String(pageQuery.limit),
        },
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(500, 'Failed to fetch messages', error);
    }
  }
}

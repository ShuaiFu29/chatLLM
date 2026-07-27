import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { getModelProviderHealth } from '../../lib/llmProviders';
import { toSafeError } from '../../lib/safeError';
import {
  findUsageConversationForUser,
  getFileQueueSummaryForUser,
  getUsageSummaryForUser,
  listUsageConversationMessagesForUser,
  listUsageConversationsForUser,
  listUsageRagRunsForConversation,
} from '../../repositories/usage';

const DEFAULT_USAGE_CONVERSATION_LIMIT = 100;
const MAX_USAGE_CONVERSATION_LIMIT = 500;
const DEFAULT_USAGE_MESSAGE_LIMIT = 500;
const MAX_USAGE_MESSAGE_LIMIT = 1000;
const DEFAULT_USAGE_RAG_RUN_LIMIT = 50;
const MAX_USAGE_RAG_RUN_LIMIT = 200;
const DEFAULT_USAGE_FILE_LIMIT = 25;
const MAX_USAGE_FILE_LIMIT = 100;

const parseBoundedLimit = (
  value: unknown,
  defaultValue: number,
  maxValue: number,
) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !raw.trim()) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultValue;

  return Math.min(parsed, maxValue);
};

@Injectable()
export class UsageService {
  getProviderHealth() {
    return getModelProviderHealth();
  }

  async getOverview(userId: string, limit: unknown, requestId?: string) {
    const conversationLimit = parseBoundedLimit(
      limit,
      DEFAULT_USAGE_CONVERSATION_LIMIT,
      MAX_USAGE_CONVERSATION_LIMIT,
    );

    try {
      const [summary, conversations] = await Promise.all([
        getUsageSummaryForUser(userId),
        listUsageConversationsForUser(userId, conversationLimit),
      ]);

      return { summary, conversations };
    } catch (error) {
      console.error(
        'Error fetching usage overview:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to fetch usage overview' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getConversation(
    userId: string,
    conversationId: string,
    rawMessageLimit: unknown,
    rawRagRunLimit: unknown,
    requestId?: string,
  ) {
    const messageLimit = parseBoundedLimit(
      rawMessageLimit,
      DEFAULT_USAGE_MESSAGE_LIMIT,
      MAX_USAGE_MESSAGE_LIMIT,
    );
    const ragRunLimit = parseBoundedLimit(
      rawRagRunLimit,
      DEFAULT_USAGE_RAG_RUN_LIMIT,
      MAX_USAGE_RAG_RUN_LIMIT,
    );

    try {
      const conversation = await findUsageConversationForUser(
        conversationId,
        userId,
      );
      if (!conversation) {
        throw new HttpException(
          { error: 'Conversation not found' },
          HttpStatus.NOT_FOUND,
        );
      }

      const [messages, ragRuns] = await Promise.all([
        listUsageConversationMessagesForUser(
          conversationId,
          userId,
          messageLimit,
        ),
        listUsageRagRunsForConversation(conversationId, userId, ragRunLimit),
      ]);

      return { conversation, messages, ragRuns };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error(
        'Error fetching usage conversation:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to fetch usage conversation' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getFileQueue(userId: string, limit: unknown, requestId?: string) {
    const fileLimit = parseBoundedLimit(
      limit,
      DEFAULT_USAGE_FILE_LIMIT,
      MAX_USAGE_FILE_LIMIT,
    );

    try {
      return await getFileQueueSummaryForUser(userId, fileLimit);
    } catch (error) {
      console.error(
        'Error fetching usage file queue:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to fetch file queue status' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

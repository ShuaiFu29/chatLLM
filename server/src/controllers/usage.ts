import { Request, Response } from 'express';
import { getModelProviderHealth } from '../lib/llmProviders';
import { toSafeError } from '../lib/safeError';
import {
  findUsageConversationForUser,
  getFileQueueSummaryForUser,
  getUsageSummaryForUser,
  listUsageConversationMessagesForUser,
  listUsageConversationsForUser,
  listUsageRagRunsForConversation,
} from '../repositories/usage';

const DEFAULT_USAGE_CONVERSATION_LIMIT = 100;
const MAX_USAGE_CONVERSATION_LIMIT = 500;
const DEFAULT_USAGE_MESSAGE_LIMIT = 500;
const MAX_USAGE_MESSAGE_LIMIT = 1000;
const DEFAULT_USAGE_RAG_RUN_LIMIT = 50;
const MAX_USAGE_RAG_RUN_LIMIT = 200;
const DEFAULT_USAGE_FILE_LIMIT = 25;
const MAX_USAGE_FILE_LIMIT = 100;

const parseBoundedLimit = (value: unknown, defaultValue: number, maxValue: number) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !raw.trim()) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultValue;

  return Math.min(parsed, maxValue);
};

export const getProviderHealth = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  res.json(getModelProviderHealth());
};

export const getUsageOverview = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const conversationLimit = parseBoundedLimit(
    req.query.limit,
    DEFAULT_USAGE_CONVERSATION_LIMIT,
    MAX_USAGE_CONVERSATION_LIMIT
  );

  try {
    const [summary, conversations] = await Promise.all([
      getUsageSummaryForUser(req.user.id),
      listUsageConversationsForUser(req.user.id, conversationLimit),
    ]);

    res.json({ summary, conversations });
  } catch (error) {
    console.error('Error fetching usage overview:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to fetch usage overview' });
  }
};

export const getUsageConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const messageLimit = parseBoundedLimit(
    req.query.messageLimit,
    DEFAULT_USAGE_MESSAGE_LIMIT,
    MAX_USAGE_MESSAGE_LIMIT
  );
  const ragRunLimit = parseBoundedLimit(
    req.query.ragRunLimit,
    DEFAULT_USAGE_RAG_RUN_LIMIT,
    MAX_USAGE_RAG_RUN_LIMIT
  );

  try {
    const conversation = await findUsageConversationForUser(conversationId, req.user.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const [messages, ragRuns] = await Promise.all([
      listUsageConversationMessagesForUser(conversationId, req.user.id, messageLimit),
      listUsageRagRunsForConversation(conversationId, req.user.id, ragRunLimit),
    ]);

    res.json({ conversation, messages, ragRuns });
  } catch (error) {
    console.error('Error fetching usage conversation:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to fetch usage conversation' });
  }
};

export const getUsageFileQueue = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const fileLimit = parseBoundedLimit(
    req.query.limit,
    DEFAULT_USAGE_FILE_LIMIT,
    MAX_USAGE_FILE_LIMIT
  );

  try {
    const fileQueue = await getFileQueueSummaryForUser(req.user.id, fileLimit);
    res.json(fileQueue);
  } catch (error) {
    console.error('Error fetching usage file queue:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to fetch file queue status' });
  }
};

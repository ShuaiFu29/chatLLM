import type { AppReply, AppRequest } from '../common/http/app-request';
import { SseWriter } from '../common/http/sse-writer';
import {
  createChatClientForModel,
  getDefaultChatModel,
  ModelProviderConfigurationError,
  UnsupportedOfficialModelError,
} from '../lib/llmProviders';
import {
  ChatSource,
  RagTraceStep,
  RagTraceSummary,
  verifyAnswerGrounding,
} from '../lib/chatSources';
import { normalizeChatMessageContent } from '../lib/chatInput';
import { normalizeMessagePageQuery } from '../lib/messagePagination';
import { normalizeSearchQuery, readSearchFilters } from '../lib/searchInput';
import { tryAcquireChatStreamSlot } from '../lib/concurrencyGate';
import { AgenticRagResponse } from '../lib/ragClient';
import { shouldUseRagForMessage } from '../lib/ragTrigger';
import {
  compareConversationsForUser,
  createConversationForUser,
  createConversationBranchForUser,
  deleteConversationForUser,
  findConversationForUser,
  listConversations,
  touchConversation,
  updateConversationForUser,
  updateConversationTitleIfPlaceholder,
} from '../repositories/conversations';
import {
  deleteMessageForUser,
  insertMessage,
  listMessagesForConversationPage,
  listRecentMessages,
  searchMessagesForUser,
  truncateConversationFromUserMessage,
} from '../repositories/messages';
import { insertRagRunForMessage } from '../repositories/ragRuns';
import { buildPersonalizedSystemPrompt } from '../lib/personaInsights';
import { getPersonaPromptContextForUser, refreshPersonaInsightsForUser } from '../repositories/persona';
import { toSafeError } from '../lib/safeError';
import {
  ensureDefaultProjectSpaceForUser,
  findProjectSpaceForUser,
} from '../repositories/projectSpaces';
import {
  buildInsufficientEvidenceAnswer,
  buildGroundedAnswerMessages,
  prepareGroundedAnswer,
  streamGroundedAnswer,
} from '../services/answerGeneration';

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
    if (!space) return null;
    return space.id;
  }

  const defaultSpace = await ensureDefaultProjectSpaceForUser(userId);
  return defaultSpace.id;
};

const ragAnswerGroundingStatusToTraceStatus = (status: string) => {
  if (status === 'supported' || status === 'not_applicable') return 'success';
  if (status === 'partial') return 'partial';
  return 'failed';
};

export const getConversations = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const projectSpaceId = readProjectSpaceId(req.query.projectSpaceId || req.query.project_space_id);
    const includeArchived = readBooleanQuery(req.query.includeArchived || req.query.include_archived);
    const conversations = await listConversations(req.user.id, { projectSpaceId, includeArchived });
    res.send(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to fetch conversations' });
  }
};

export const searchMessages = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const normalizedQuery = normalizeSearchQuery(req.query.q);

  if (!normalizedQuery.ok) {
    res.code(normalizedQuery.statusCode).send({ error: normalizedQuery.error });
    return;
  }

  try {
    const results = await searchMessagesForUser(req.user.id, normalizedQuery.query, readSearchFilters(req.query));
    res.send(results);
  } catch (error) {
    console.error('Error searching messages:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to search messages' });
  }
};

export const createConversation = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const { title } = req.body;

  try {
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.code(404).send({ error: 'Project space not found' });

    const conversation = await createConversationForUser(req.user.id, title || 'New Chat', projectSpaceId);
    res.send(conversation);
  } catch (error) {
    console.error('Error creating conversation:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to create conversation' });
  }
};

export const updateConversation = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const { title, model, temperature, system_prompt, enable_rag, is_pinned, archived, is_favorite, tags, note } = req.body;

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
  if (archived !== undefined) updates.archived_at = archived ? new Date().toISOString() : null;
  if (is_favorite !== undefined) updates.is_favorite = is_favorite;
  if (tags !== undefined) updates.tags = tags;
  if (note !== undefined) updates.note = note;

  if (req.body.project_space_id !== undefined || req.body.projectSpaceId !== undefined) {
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId);
    if (!requestedProjectSpaceId) {
      updates.project_space_id = null;
    } else {
      const space = await findProjectSpaceForUser(requestedProjectSpaceId, req.user.id);
      if (!space) return res.code(404).send({ error: 'Project space not found' });
      updates.project_space_id = space.id;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.code(400).send({ error: 'No fields to update' });
  }

  try {
    const conversation = await updateConversationForUser(conversationId, req.user.id, updates);

    if (!conversation) {
      return res.code(404).send({ error: 'Conversation not found' });
    }

    res.send(conversation);
  } catch (error) {
    console.error('Error updating conversation:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to update conversation' });
  }
};

export const branchConversation = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const { messageId, title } = req.body;

  try {
    const conversation = await createConversationBranchForUser({
      userId: req.user.id,
      conversationId,
      messageId,
      title,
    });

    if (!conversation) return res.code(404).send({ error: 'Conversation or message not found' });
    res.send(conversation);
  } catch (error) {
    console.error('Error branching conversation:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to branch conversation' });
  }
};

export const compareConversations = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const { conversationId, otherConversationId } = req.params;

  try {
    const comparison = await compareConversationsForUser(req.user.id, conversationId, otherConversationId);
    if (!comparison) return res.code(404).send({ error: 'Conversation not found' });
    res.send(comparison);
  } catch (error) {
    console.error('Error comparing conversations:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to compare conversations' });
  }
};

export const deleteConversation = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const { conversationId } = req.params;

  try {
    const deleted = await deleteConversationForUser(conversationId, req.user.id);
    if (!deleted) return res.code(404).send({ error: 'Conversation not found' });
    res.send({ success: true });
  } catch (error) {
    console.error('Error deleting conversation:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to delete conversation' });
  }
};

export const deleteMessage = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const { messageId } = req.params;

  try {
    const deleted = await deleteMessageForUser(messageId, req.user.id);
    if (!deleted) return res.code(404).send({ error: 'Message not found' });
    res.send({ success: true });
  } catch (error) {
    console.error('Error deleting message:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to delete message' });
  }
};

export const truncateConversation = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const { conversationId, messageId } = req.params;

  try {
    const result = await truncateConversationFromUserMessage(conversationId, messageId, req.user.id);
    if (!result) return res.code(404).send({ error: 'Conversation or user message not found' });
    res.send({ success: true, ...result });
  } catch (error) {
    console.error('Error truncating conversation:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to truncate conversation' });
  }
};

const generateConversationTitle = async (conversationId: string, firstMessage: string) => {
  try {
    const { client: titleClient, resolvedModel } = createChatClientForModel(getDefaultChatModel());
    const response = await titleClient.chat.completions.create({
      model: resolvedModel,
      messages: [
        {
          role: 'system',
          content: 'Generate a short, concise title (maximum 5 words) for a conversation based on the following user message. The title should be in the same language as the user message. Do not use quotes. Return ONLY the title.',
        },
        { role: 'user', content: firstMessage },
      ],
      max_tokens: 20,
      temperature: 0.7,
    });

    const title = response.choices[0]?.message?.content?.trim();
    if (title) await updateConversationTitleIfPlaceholder(conversationId, title);
  } catch (error) {
    console.warn('[Chat] Failed to generate title:', toSafeError(error));
  }
};

export const getMessages = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const pageQuery = normalizeMessagePageQuery(req.query);

  if (!pageQuery.ok) {
    res.code(pageQuery.statusCode).send({ error: pageQuery.error });
    return;
  }

  try {
    const conversation = await findConversationForUser(conversationId, req.user.id);
    if (!conversation) return res.code(403).send({ error: 'Forbidden' });

    const page = await listMessagesForConversationPage(conversationId, pageQuery);
    res.header('x-chatllm-has-more', String(page.hasMore));
    res.header('x-chatllm-next-cursor', page.nextCursor || '');
    res.header('x-chatllm-page-limit', String(pageQuery.limit));
    res.send(page.messages);
  } catch (error) {
    console.error('Error fetching messages:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to fetch messages' });
  }
};

const isChatConnectionClosed = (req: AppRequest, res: AppReply) => (
  req.raw.aborted
  || req.raw.destroyed
  || res.raw.destroyed
  || res.raw.writableEnded
);

export const sendMessage = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const normalizedContent = normalizeChatMessageContent(req.body.content);

  if (!normalizedContent.ok) {
    res.code(normalizedContent.statusCode).send({ error: normalizedContent.error });
    return;
  }
  const { content } = normalizedContent;

  const conversation = await findConversationForUser(conversationId, req.user.id);
  if (!conversation) {
    res.code(403).send({ error: 'Forbidden' });
    return;
  }
  if (isChatConnectionClosed(req, res)) return;

  const chatSlot = tryAcquireChatStreamSlot(req.user.id);
  if (!chatSlot.acquired) {
    res.header('Retry-After', String(chatSlot.retryAfterSeconds));
    res.code(429).send({
      error: 'Too many active chat streams',
      retryAfter: chatSlot.retryAfterSeconds,
    });
    return;
  }

  let streamStarted = false;
  let failed = false;
  const streamAbortController = new AbortController();
  const sse = new SseWriter(res);
  let upstreamAborted = false;
  const abortUpstreamStream = () => {
    if (upstreamAborted || streamAbortController.signal.aborted) return;
    upstreamAborted = true;
    streamAbortController.abort();
  };

  req.raw.once('aborted', abortUpstreamStream);
  res.raw.once('close', abortUpstreamStream);
  if (isChatConnectionClosed(req, res)) abortUpstreamStream();

  try {
    if (streamAbortController.signal.aborted) return;
    const model = conversation.model || getDefaultChatModel();
    const userMessage = await insertMessage(conversationId, 'user', content);
    refreshPersonaInsightsForUser(req.user.id).catch((error) => {
      console.warn('[Chat] Failed to refresh persona insights:', toSafeError(error, req.requestId));
    });

    if (conversation.title === 'New Chat') {
      generateConversationTitle(conversationId, content);
    }

    touchConversation(conversationId, req.user.id).catch((error) => {
      console.warn('[Chat] Failed to update conversation timestamp:', toSafeError(error, req.requestId));
    });

    if (!sse.open()) return;
    streamStarted = true;

    const temperature = conversation.temperature !== undefined && conversation.temperature !== null
      ? conversation.temperature
      : 0.7;
    const systemPrompt = conversation.system_prompt || 'You are a helpful AI assistant.';
    const personaProfile = await getPersonaPromptContextForUser(req.user.id);
    const personalizedSystemPrompt = buildPersonalizedSystemPrompt(systemPrompt, personaProfile);
    const enableRag = conversation.enable_rag !== undefined ? conversation.enable_rag : true;
    const shouldRunRag = enableRag && shouldUseRagForMessage(content);
    const history = await listRecentMessages(conversationId, 10);

    let contextText = '';
    let assistantSources: ChatSource[] = [];
    let verificationSources: ChatSource[] = [];
    let agenticRagRun: AgenticRagResponse | null = null;
    let traceSummary: RagTraceSummary | null = null;
    let insufficientEvidence = false;
    let answerGuidance = '';

    if (enableRag && !shouldRunRag) {
      await sse.send({ ragSkipped: true });
    }

    if (shouldRunRag) {
      try {
        const preparedAnswer = await prepareGroundedAnswer({
          question: content,
          userId: req.user.id,
          projectSpaceId: conversation.project_space_id || undefined,
          conversationId,
          historyNewestFirst: history.map((message) => ({
            role: message.role as 'user' | 'assistant' | 'system',
            content: message.content,
          })),
          signal: streamAbortController.signal,
        });
        agenticRagRun = preparedAnswer.ragRun;
        traceSummary = preparedAnswer.traceSummary;
        insufficientEvidence = preparedAnswer.insufficientEvidence;
        answerGuidance = preparedAnswer.answerGuidance;
        contextText = preparedAnswer.contextText;
        assistantSources = preparedAnswer.assistantSources;
        verificationSources = preparedAnswer.verificationSources;
        await sse.send({
          ragRunId: agenticRagRun.run_id,
          sources: assistantSources,
          traceSummary,
          qualitySummary: agenticRagRun.quality,
          insufficientEvidence,
          answer_guidance: answerGuidance,
        });
      } catch (error) {
        if (streamAbortController.signal.aborted || sse.isClosed) {
          sse.close();
          return;
        }
        failed = true;
        console.warn('[Chat] RAG retrieval failed; answer generation stopped:', toSafeError(error, req.requestId));
        await sse.send({
          ragError: {
            code: 'rag_retrieval_unavailable',
            retryable: true,
            message: 'Workspace document retrieval failed. Retry before relying on an answer.',
          },
        });
        await sse.done();
        sse.close();
        return;
      }
    }

    let fullContent = '';

    await sse.send({ userMessageId: userMessage.id });

    if (shouldRunRag && insufficientEvidence && !contextText.trim()) {
      fullContent = buildInsufficientEvidenceAnswer(content);
      // This local policy response deliberately bypasses the answer model when no evidence exists.
      await sse.send({ content: fullContent, deterministicAbstention: true });
    } else {
      const { client: chatClient, resolvedModel } = createChatClientForModel(model);
      const messages = buildGroundedAnswerMessages({
        systemPrompt: personalizedSystemPrompt,
        historyNewestFirst: history.map((message) => ({
          role: message.role as 'user' | 'assistant' | 'system',
          content: message.content,
        })),
        question: content,
        contextText,
        answerGuidance,
      });
      const stream = await streamGroundedAnswer({
        client: chatClient,
        resolvedModel,
        messages,
        temperature,
        signal: streamAbortController.signal,
      });

      for await (const chunk of stream) {
        if (sse.isClosed) break;
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullContent += delta;
          await sse.send({ content: delta });
        }
      }
    }

    if (fullContent) {
      let finalAssistantSources = assistantSources;
      let finalTraceSteps = traceSummary?.trace_steps || agenticRagRun?.trace_steps || [];
      let finalQuality = agenticRagRun?.quality;
      let finalTraceSummary = traceSummary;

      if (agenticRagRun) {
        const startedAt = Date.now();
        const answerGrounding = verifyAnswerGrounding(
          fullContent,
          assistantSources,
          agenticRagRun.quality,
          insufficientEvidence,
          verificationSources
        );
        finalAssistantSources = answerGrounding.verified_sources;
        const groundingStep: RagTraceStep = {
          step_type: 'answer_grounding_check',
          status: ragAnswerGroundingStatusToTraceStatus(answerGrounding.status),
          duration_ms: Math.max(0, Date.now() - startedAt),
          input: {
            answer_length: fullContent.length,
            source_count: assistantSources.length,
          },
          output: { ...answerGrounding },
        };
        finalTraceSteps = [...finalTraceSteps, groundingStep];
        finalQuality = {
          ...agenticRagRun.quality,
          answer_grounding_status: answerGrounding.status,
          answer_grounding_score: answerGrounding.score,
        };
        finalTraceSummary = traceSummary
          ? {
              ...traceSummary,
              trace_steps: finalTraceSteps,
              quality: finalQuality,
              answer_grounding: answerGrounding,
            }
          : null;

        await sse.send({
          sources: finalAssistantSources,
          traceSummary: finalTraceSummary,
          qualitySummary: finalQuality,
          answerGrounding: answerGrounding,
        });
      }

      const assistantMessage = await insertMessage(conversationId, 'assistant', fullContent, finalAssistantSources);
      if (agenticRagRun) {
        insertRagRunForMessage({
          runId: agenticRagRun.run_id,
          userId: req.user.id,
          conversationId,
          assistantMessageId: assistantMessage.id,
          mode: agenticRagRun.mode,
          query: content,
          plannedQueries: agenticRagRun.planned_queries || [],
          traceSteps: finalTraceSteps,
          quality: finalQuality || agenticRagRun.quality,
          retrievedSources: finalAssistantSources,
          status: finalQuality?.evidence_label === 'weak' || finalQuality?.answer_grounding_status === 'unsupported' ? 'partial' : 'success',
        }).catch((error) => {
          console.warn('[Chat] Failed to persist RAG trace:', toSafeError(error, req.requestId));
        });
      }
      await sse.send({ assistantMessageId: assistantMessage.id });
    }

    await sse.done();
    sse.close();
  } catch (error) {
    failed = !streamAbortController.signal.aborted;
    if (streamAbortController.signal.aborted) {
      sse.close();
      return;
    }
    console.error('[Chat] Failed to generate response:', toSafeError(error, req.requestId));
    if (streamStarted) {
      await sse.send({ error: 'Failed to generate response' });
      sse.close();
    } else {
      const statusCode = error instanceof ModelProviderConfigurationError || error instanceof UnsupportedOfficialModelError
        ? error.statusCode
        : 500;
      res.code(statusCode).send({ error: 'Failed to generate response' });
    }
  } finally {
    req.raw.off('aborted', abortUpstreamStream);
    res.raw.off('close', abortUpstreamStream);
    chatSlot.release(failed);
  }
};

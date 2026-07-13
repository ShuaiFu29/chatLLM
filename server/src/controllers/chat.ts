import { Request, Response } from 'express';
import {
  createChatClientForModel,
  getDefaultChatModel,
  ModelProviderConfigurationError,
  UnsupportedOfficialModelError,
} from '../lib/llmProviders';
import {
  buildChatSources,
  buildAnswerTaskGuidance,
  buildRagContext,
  buildVerificationSources,
  ChatSource,
  RagTraceStep,
  RagTraceSummary,
  verifyAnswerGrounding,
} from '../lib/chatSources';
import { normalizeChatMessageContent } from '../lib/chatInput';
import { normalizeMessagePageQuery } from '../lib/messagePagination';
import { normalizeSearchQuery, readSearchFilters } from '../lib/searchInput';
import { tryAcquireChatStreamSlot } from '../lib/concurrencyGate';
import { AgenticRagResponse, retrieveAgenticRagDocuments } from '../lib/ragClient';
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

export const getConversations = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const projectSpaceId = readProjectSpaceId(req.query.projectSpaceId || req.query.project_space_id);
    const includeArchived = readBooleanQuery(req.query.includeArchived || req.query.include_archived);
    const conversations = await listConversations(req.user.id, { projectSpaceId, includeArchived });
    res.json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
};

export const searchMessages = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const normalizedQuery = normalizeSearchQuery(req.query.q);

  if (!normalizedQuery.ok) {
    res.status(normalizedQuery.statusCode).json({ error: normalizedQuery.error });
    return;
  }

  try {
    const results = await searchMessagesForUser(req.user.id, normalizedQuery.query, readSearchFilters(req.query));
    res.json(results);
  } catch (error) {
    console.error('Error searching messages:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to search messages' });
  }
};

export const createConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { title } = req.body;

  try {
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.status(404).json({ error: 'Project space not found' });

    const conversation = await createConversationForUser(req.user.id, title || 'New Chat', projectSpaceId);
    res.json(conversation);
  } catch (error) {
    console.error('Error creating conversation:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to create conversation' });
  }
};

export const updateConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
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
      if (!space) return res.status(404).json({ error: 'Project space not found' });
      updates.project_space_id = space.id;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    const conversation = await updateConversationForUser(conversationId, req.user.id, updates);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json(conversation);
  } catch (error) {
    console.error('Error updating conversation:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to update conversation' });
  }
};

export const branchConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const { messageId, title } = req.body;

  try {
    const conversation = await createConversationBranchForUser({
      userId: req.user.id,
      conversationId,
      messageId,
      title,
    });

    if (!conversation) return res.status(404).json({ error: 'Conversation or message not found' });
    res.json(conversation);
  } catch (error) {
    console.error('Error branching conversation:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to branch conversation' });
  }
};

export const compareConversations = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId, otherConversationId } = req.params;

  try {
    const comparison = await compareConversationsForUser(req.user.id, conversationId, otherConversationId);
    if (!comparison) return res.status(404).json({ error: 'Conversation not found' });
    res.json(comparison);
  } catch (error) {
    console.error('Error comparing conversations:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to compare conversations' });
  }
};

export const deleteConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId } = req.params;

  try {
    const deleted = await deleteConversationForUser(conversationId, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting conversation:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
};

export const deleteMessage = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { messageId } = req.params;

  try {
    const deleted = await deleteMessageForUser(messageId, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Message not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting message:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

export const truncateConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId, messageId } = req.params;

  try {
    const result = await truncateConversationFromUserMessage(conversationId, messageId, req.user.id);
    if (!result) return res.status(404).json({ error: 'Conversation or user message not found' });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error truncating conversation:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to truncate conversation' });
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

export const getMessages = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const pageQuery = normalizeMessagePageQuery(req.query);

  if (!pageQuery.ok) {
    res.status(pageQuery.statusCode).json({ error: pageQuery.error });
    return;
  }

  try {
    const conversation = await findConversationForUser(conversationId, req.user.id);
    if (!conversation) return res.status(403).json({ error: 'Forbidden' });

    const page = await listMessagesForConversationPage(conversationId, pageQuery);
    res.setHeader('x-chatllm-has-more', String(page.hasMore));
    res.setHeader('x-chatllm-next-cursor', page.nextCursor || '');
    res.setHeader('x-chatllm-page-limit', String(pageQuery.limit));
    res.json(page.messages);
  } catch (error) {
    console.error('Error fetching messages:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
};

export const sendMessage = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const normalizedContent = normalizeChatMessageContent(req.body.content);

  if (!normalizedContent.ok) {
    res.status(normalizedContent.statusCode).json({ error: normalizedContent.error });
    return;
  }
  const { content } = normalizedContent;

  const conversation = await findConversationForUser(conversationId, req.user.id);
  if (!conversation) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const chatSlot = tryAcquireChatStreamSlot(req.user.id);
  if (!chatSlot.acquired) {
    res.setHeader('Retry-After', String(chatSlot.retryAfterSeconds));
    res.status(429).json({
      error: 'Too many active chat streams',
      retryAfter: chatSlot.retryAfterSeconds,
    });
    return;
  }

  let streamStarted = false;
  let failed = false;
  const streamAbortController = new AbortController();
  const abortUpstreamStream = () => {
    if (!res.writableEnded) {
      streamAbortController.abort();
    }
  };

  req.on('close', () => {
    if (streamStarted) abortUpstreamStream();
  });
  res.on('close', abortUpstreamStream);

  try {
    const model = conversation.model || getDefaultChatModel();
    const { client: chatClient, resolvedModel } = createChatClientForModel(model);
    const userMessage = await insertMessage(conversationId, 'user', content);
    refreshPersonaInsightsForUser(req.user.id).catch((error) => {
      console.warn('[Chat] Failed to refresh persona insights:', toSafeError(error, res.locals.requestId));
    });

    if (conversation.title === 'New Chat') {
      generateConversationTitle(conversationId, content);
    }

    touchConversation(conversationId, req.user.id).catch((error) => {
      console.warn('[Chat] Failed to update conversation timestamp:', toSafeError(error, res.locals.requestId));
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    streamStarted = true;

    const temperature = conversation.temperature !== undefined && conversation.temperature !== null
      ? conversation.temperature
      : 0.7;
    const systemPrompt = conversation.system_prompt || 'You are a helpful AI assistant.';
    const personaProfile = await getPersonaPromptContextForUser(req.user.id);
    const personalizedSystemPrompt = buildPersonalizedSystemPrompt(systemPrompt, personaProfile);
    const enableRag = conversation.enable_rag !== undefined ? conversation.enable_rag : true;
    const shouldRunRag = enableRag && shouldUseRagForMessage(content);

    let contextText = '';
    let assistantSources: ChatSource[] = [];
    let verificationSources: ChatSource[] = [];
    let agenticRagRun: AgenticRagResponse | null = null;
    let traceSummary: RagTraceSummary | null = null;
    let insufficientEvidence = false;
    let answerGuidance = '';

    if (enableRag && !shouldRunRag) {
      res.write(`data: ${JSON.stringify({ ragSkipped: true })}\n\n`);
    }

    if (shouldRunRag) {
      try {
        agenticRagRun = await retrieveAgenticRagDocuments({
          query: content,
          user_id: req.user.id,
          project_space_id: conversation.project_space_id || undefined,
          conversation_id: conversationId,
          limit: 10,
          threshold: 0.1,
        });
        const documents = agenticRagRun.results || [];
        traceSummary = {
          mode: agenticRagRun.mode,
          intent: agenticRagRun.intent,
          planned_queries: agenticRagRun.planned_queries || [],
          trace_steps: agenticRagRun.trace_steps || [],
          quality: agenticRagRun.quality,
          insufficient_evidence: agenticRagRun.insufficient_evidence,
          answer_guidance: agenticRagRun.answer_guidance,
          cache: agenticRagRun.cache,
        };
        insufficientEvidence = Boolean(agenticRagRun.insufficient_evidence);
        answerGuidance = agenticRagRun.answer_guidance || '';

        if (documents && documents.length > 0) {
          const contextBuild = buildRagContext(documents);
          contextText = contextBuild.text;
          assistantSources = buildChatSources(documents);
          verificationSources = buildVerificationSources(documents);
          const contextStep: RagTraceStep = {
            step_type: 'answer_context_pack',
            status: contextBuild.allocations.some((item) => item.truncated) ? 'partial' : 'success',
            duration_ms: 0,
            input: {
              document_count: documents.length,
              context_budget: 12000,
            },
            output: {
              context_length: contextBuild.text.length,
              source_map: contextBuild.source_map,
              allocations: contextBuild.allocations,
            },
          };
          traceSummary = traceSummary
            ? { ...traceSummary, trace_steps: [...traceSummary.trace_steps, contextStep] }
            : traceSummary;
        }
        // This is JSON-encoded SSE under text/event-stream, never an HTML response.
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
        res.write(`data: ${JSON.stringify({
          ragRunId: agenticRagRun.run_id,
          sources: assistantSources,
          traceSummary,
          qualitySummary: agenticRagRun.quality,
          insufficientEvidence,
          answer_guidance: answerGuidance,
        })}\n\n`);
      } catch (error) {
        console.warn('[Chat] RAG retrieval failed; continuing without context:', toSafeError(error, res.locals.requestId));
        res.write(`data: ${JSON.stringify({ rag_warning: 'Knowledge retrieval failed; answering without retrieved context.' })}\n\n`);
      }
    }

    const history = await listRecentMessages(conversationId, 10);
    const messages = history.reverse().map((msg) => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content,
    }));

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== content) {
      messages.push({ role: 'user', content });
    }

    if (contextText) {
      const lastMsgIndex = messages.length - 1;
      if (lastMsgIndex >= 0 && messages[lastMsgIndex].role === 'user') {
        const originalContent = messages[lastMsgIndex].content;
        const evidenceGuidance = answerGuidance
          ? `${answerGuidance}\n\n`
          : '';
        const taskGuidance = buildAnswerTaskGuidance(originalContent);
        messages[lastMsgIndex].content = `${evidenceGuidance}${taskGuidance}\n\nBased on the following context, please answer the user's question.
If the answer is not in the context, say that the retrieved source material is insufficient.
Do not use general knowledge as document evidence, and do not attach citations to claims that are not supported by the context.
Use source labels such as [Source 1] only when the claim is directly supported by that source.
Answer every explicit part of the question instead of stopping after the first relevant fact.
Answer in the same language as the user's question unless the user explicitly requests another language.
Preserve material numbers, units, versions, dates, conditions, exceptions, and negation exactly as supported by the sources.
Place a source label immediately after each substantive document-backed claim; do not use one citation group to cover unrelated claims.
Distinguish current rules from deprecated or historical material, and do not turn a control measure into proof that every root cause is resolved.
Inventory rows are context for document-list questions; do not treat them as document evidence citations.
Do not mention "Based on the provided context" or similar phrases in your answer unless necessary to clarify source limits.

Context:
${contextText}

Question:
${originalContent}`;
      }
    }

    const stream = await chatClient.chat.completions.create({
      model: resolvedModel,
      messages: [
        { role: 'system', content: personalizedSystemPrompt },
        ...messages,
      ],
      stream: true,
      temperature,
      signal: streamAbortController.signal,
    });

    let fullContent = '';

    // JSON-encoded SSE is parsed as event data, not rendered as HTML.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    res.write(`data: ${JSON.stringify({ userMessageId: userMessage.id })}\n\n`);

    for await (const chunk of stream) {
      if (res.destroyed) break;
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullContent += delta;
        // JSON.stringify safely frames model text inside the SSE data payload.
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
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

        // This response remains JSON-encoded SSE under the stream content type.
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
        res.write(`data: ${JSON.stringify({
          sources: finalAssistantSources,
          traceSummary: finalTraceSummary,
          qualitySummary: finalQuality,
          answerGrounding: answerGrounding,
        })}\n\n`);
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
          console.warn('[Chat] Failed to persist RAG trace:', toSafeError(error, res.locals.requestId));
        });
      }
      // JSON-encoded identifiers are emitted as SSE event data, not HTML.
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      res.write(`data: ${JSON.stringify({ assistantMessageId: assistantMessage.id })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    failed = !streamAbortController.signal.aborted;
    if (streamAbortController.signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }
    console.error('[Chat] Failed to generate response:', toSafeError(error, res.locals.requestId));
    if (streamStarted) {
      res.write(`data: ${JSON.stringify({ error: 'Failed to generate response' })}\n\n`);
      res.end();
    } else {
      const statusCode = error instanceof ModelProviderConfigurationError || error instanceof UnsupportedOfficialModelError
        ? error.statusCode
        : 500;
      res.status(statusCode).json({ error: 'Failed to generate response' });
    }
  } finally {
    chatSlot.release(failed);
  }
};

import { Request, Response } from 'express';
import { openai } from '../lib/openai';
import { buildChatSources, ChatSource, RagTraceSummary } from '../lib/chatSources';
import { normalizeChatMessageContent } from '../lib/chatInput';
import { normalizeMessagePageQuery } from '../lib/messagePagination';
import { normalizeSearchQuery, readSearchFilters } from '../lib/searchInput';
import { tryAcquireChatStreamSlot } from '../lib/concurrencyGate';
import { AgenticRagResponse, retrieveAgenticRagDocuments } from '../lib/ragClient';
import {
  compareConversationsForUser,
  createConversationForUser,
  createConversationBranchForUser,
  deleteConversationForUser,
  findConversationForUser,
  listConversations,
  touchConversation,
  updateConversationForUser,
  updateConversationTitle,
} from '../repositories/conversations';
import {
  deleteMessageForUser,
  insertMessage,
  listMessagesForConversationPage,
  listRecentMessages,
  searchMessagesForUser,
} from '../repositories/messages';
import { insertRagRunForMessage } from '../repositories/ragRuns';
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

export const getConversations = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const projectSpaceId = readProjectSpaceId(req.query.projectSpaceId || req.query.project_space_id);
    const includeArchived = readBooleanQuery(req.query.includeArchived || req.query.include_archived);
    const conversations = await listConversations(req.user.id, { projectSpaceId, includeArchived });
    res.json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
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
    console.error('Error searching messages:', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
};

export const createConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { title } = req.body;

  try {
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId);
    const projectSpaceId = await resolveProjectSpaceId(req.user.id, requestedProjectSpaceId);
    if (!projectSpaceId) return res.status(404).json({ error: 'Project space not found' });

    const conversation = await createConversationForUser(req.user.id, title || 'New Chat', projectSpaceId);
    res.json(conversation);
  } catch (error) {
    console.error('Error creating conversation:', error);
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
  if (is_pinned !== undefined) updates.is_pinned = Boolean(is_pinned);
  if (archived !== undefined) updates.archived_at = archived ? new Date().toISOString() : null;
  if (is_favorite !== undefined) updates.is_favorite = Boolean(is_favorite);
  if (Array.isArray(tags)) {
    updates.tags = tags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  if (note !== undefined && typeof note === 'string') updates.note = note.slice(0, 2000);

  if (req.body.project_space_id !== undefined || req.body.projectSpaceId !== undefined) {
    const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId);
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
    console.error('Error updating conversation:', error);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
};

export const branchConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const messageId = typeof req.body.messageId === 'string' ? req.body.messageId : undefined;
  const title = typeof req.body.title === 'string' ? req.body.title : undefined;

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
    console.error('Error branching conversation:', error);
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
    console.error('Error comparing conversations:', error);
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
    console.error('Error deleting conversation:', error);
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
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

const generateConversationTitle = async (conversationId: string, firstMessage: string) => {
  try {
    const response = await openai.chat.completions.create({
      model: 'deepseek-chat',
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
    if (title) await updateConversationTitle(conversationId, title);
  } catch (error) {
    console.warn('[Chat] Failed to generate title:', error);
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
    console.error('Error fetching messages:', error);
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

  try {
    const userMessage = await insertMessage(conversationId, 'user', content);

    if (conversation.title === 'New Chat') {
      generateConversationTitle(conversationId, content);
    }

    touchConversation(conversationId, req.user.id).catch((error) => {
      console.warn('[Chat] Failed to update conversation timestamp:', error);
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    streamStarted = true;

    const model = conversation.model || 'deepseek-chat';
    const temperature = conversation.temperature !== undefined && conversation.temperature !== null
      ? conversation.temperature
      : 0.7;
    const systemPrompt = conversation.system_prompt || 'You are a helpful AI assistant.';
    const enableRag = conversation.enable_rag !== undefined ? conversation.enable_rag : true;

    let contextText = '';
    let assistantSources: ChatSource[] = [];
    let agenticRagRun: AgenticRagResponse | null = null;
    let traceSummary: RagTraceSummary | null = null;
    let insufficientEvidence = false;
    let answerGuidance = '';

    if (enableRag) {
      try {
        agenticRagRun = await retrieveAgenticRagDocuments({
          query: content,
          user_id: req.user.id,
          project_space_id: conversation.project_space_id || undefined,
          limit: 10,
          threshold: 0.1,
        });
        const documents = agenticRagRun.results || [];
        traceSummary = {
          mode: agenticRagRun.mode,
          planned_queries: agenticRagRun.planned_queries || [],
          trace_steps: agenticRagRun.trace_steps || [],
          quality: agenticRagRun.quality,
          insufficient_evidence: agenticRagRun.insufficient_evidence,
          answer_guidance: agenticRagRun.answer_guidance,
        };
        insufficientEvidence = Boolean(agenticRagRun.insufficient_evidence);
        answerGuidance = agenticRagRun.answer_guidance || '';

        if (documents && documents.length > 0) {
          contextText = documents.map((doc) => doc.content || '').join('\n---\n');

          assistantSources = buildChatSources(documents);
        }
        res.write(`data: ${JSON.stringify({
          ragRunId: agenticRagRun.run_id,
          sources: assistantSources,
          traceSummary,
          qualitySummary: agenticRagRun.quality,
          insufficientEvidence,
          answer_guidance: answerGuidance,
        })}\n\n`);
      } catch (error) {
        console.warn('[Chat] RAG retrieval failed; continuing without context:', error);
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
        const evidenceGuidance = insufficientEvidence && answerGuidance
          ? `${answerGuidance}\n\n`
          : '';
        messages[lastMsgIndex].content = `${evidenceGuidance}Based on the following context, please answer the user's question.
If the answer is not in the context, say so, but you can still use your general knowledge.
Do not mention "Based on the provided context" or similar phrases in your answer unless necessary to clarify sources.

Context:
${contextText}

Question:
${originalContent}`;
      }
    }

    const stream = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      stream: true,
      temperature,
    });

    let fullContent = '';

    res.write(`data: ${JSON.stringify({ userMessageId: userMessage.id })}\n\n`);

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullContent += delta;
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
    }

    if (fullContent) {
      const assistantMessage = await insertMessage(conversationId, 'assistant', fullContent, assistantSources);
      if (agenticRagRun) {
        insertRagRunForMessage({
          runId: agenticRagRun.run_id,
          userId: req.user.id,
          conversationId,
          assistantMessageId: assistantMessage.id,
          mode: agenticRagRun.mode,
          query: content,
          plannedQueries: agenticRagRun.planned_queries || [],
          traceSteps: agenticRagRun.trace_steps || [],
          quality: agenticRagRun.quality,
          retrievedSources: assistantSources,
          status: traceSummary?.quality?.evidence_label === 'weak' ? 'partial' : 'success',
        }).catch((error) => {
          console.warn('[Chat] Failed to persist RAG trace:', error);
        });
      }
      res.write(`data: ${JSON.stringify({ assistantMessageId: assistantMessage.id })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    failed = true;
    console.error('[Chat] Failed to generate response:', error);
    if (streamStarted) {
      res.write(`data: ${JSON.stringify({ error: 'Failed to generate response' })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: 'Failed to generate response' });
    }
  } finally {
    chatSlot.release(failed);
  }
};

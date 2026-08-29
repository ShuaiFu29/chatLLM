import { HttpException, Injectable, StreamableFile } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'stream';
import { httpResponse } from '../../common/http/http-response';
import { SSE_HEADERS, SseWriter } from '../../common/http/sse-writer';
import {
  createChatClientForModel,
  getDefaultChatModel,
  ModelProviderConfigurationError,
  UnsupportedOfficialModelError,
} from '../../lib/llmProviders';
import {
  ChatSource,
  RagTraceStep,
  RagTraceSummary,
  verifyAnswerGrounding,
} from '../../lib/chatSources';
import { normalizeChatMessageContent } from '../../lib/chatInput';
import { tryAcquireChatStreamSlot } from '../../lib/concurrencyGate';
import { AgenticRagResponse } from '../../lib/ragClient';
import { shouldUseRagForMessage } from '../../lib/ragTrigger';
import {
  findConversationForUser,
  touchConversation,
  updateConversationTitleIfPlaceholder,
} from '../../repositories/conversations';
import {
  insertMessage,
  findLatestUserMessageForConversation,
  listRecentMessages,
} from '../../repositories/messages';
import { insertRagRunForMessage } from '../../repositories/ragRuns';
import { buildPersonalizedSystemPrompt } from '../../lib/personaInsights';
import { getPersonaPromptContextForUser, refreshPersonaInsightsForUser } from '../../repositories/persona';
import { toSafeError } from '../../lib/safeError';
import {
  buildInsufficientEvidenceAnswer,
  buildGroundedAnswerMessages,
  prepareGroundedAnswer,
  streamGroundedAnswer,
} from '../../services/answerGeneration';
import { User } from '../../types';
import { AgentRunService } from '../agents/agent-run.service';
import { agentRecoveryQueue } from '../../services/agentRecoveryQueue';

export interface ChatStreamRequest {
  user: User;
  conversationId: string;
  content: unknown;
  continueGeneration?: boolean;
  connection: IncomingMessage;
  requestId?: string;
}

const ragAnswerGroundingStatusToTraceStatus = (status: string) => {
  if (status === 'supported' || status === 'not_applicable') return 'success';
  if (status === 'partial') return 'partial';
  return 'failed';
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
      signal: AbortSignal.timeout(30_000),
    });

    const title = response.choices[0]?.message?.content?.trim();
    if (title) await updateConversationTitleIfPlaceholder(conversationId, title);
  } catch (error) {
    console.warn('[Chat] Failed to generate title:', toSafeError(error));
  }
};

// A connected browser request can stay open indefinitely. Keep a separate
// model-call deadline so an upstream provider that stops sending bytes cannot
// hold a chat stream slot forever. Agent runs have their own configured
// deadline and do not use this regular-chat timeout.
const CHAT_MODEL_TIMEOUT_MS = 120_000;

const isChatRequestClosed = (request: ChatStreamRequest) => (
  request.connection.aborted
  || request.connection.destroyed
);

const isChatConnectionClosed = (request: ChatStreamRequest, stream: PassThrough) => (
  isChatRequestClosed(request)
  || stream.destroyed
  || stream.writableEnded
);

const publicError = (statusCode: number, error: string, cause?: unknown) => (
  new HttpException(
    { error },
    statusCode,
    cause === undefined ? undefined : { cause },
  )
);

const createChatStream = async (
  request: ChatStreamRequest,
  agentRunService: AgentRunService,
) => {
  const { user, conversationId } = request;
  const normalizedContent = normalizeChatMessageContent(request.content);

  if (!normalizedContent.ok) {
    throw publicError(normalizedContent.statusCode, normalizedContent.error);
  }
  const { content } = normalizedContent;

  const conversation = await findConversationForUser(conversationId, user.id);
  if (!conversation) throw publicError(403, 'Forbidden');

  // An Agent turn is a whole tool loop that persists exactly one final answer.
  // "Continue" is a generation control for plain chat; routing it into an Agent
  // would start a second Run against the same user message and leave two
  // assistant bubbles on one turn. Reject it on the server, not only in the UI.
  if (request.continueGeneration && conversation.agent_id) {
    throw publicError(400, 'Continue is not supported in an Agent conversation');
  }
  if (isChatRequestClosed(request)) return;

  const chatSlot = tryAcquireChatStreamSlot(user.id);
  if (!chatSlot.acquired) {
    return httpResponse(
      {
        error: 'Too many active chat streams',
        retryAfter: chatSlot.retryAfterSeconds,
      },
      {
        statusCode: 429,
        headers: { 'Retry-After': String(chatSlot.retryAfterSeconds) },
      },
    );
  }

  let userMessage;
  try {
    if (request.continueGeneration) {
      // The continue prompt is a synthetic instruction, never a user turn. With
      // no earlier user message there is nothing to continue, so fail instead of
      // persisting "Please continue your response..." as chat history.
      const previousUserMessage = await findLatestUserMessageForConversation(conversationId);
      if (!previousUserMessage) {
        chatSlot.release(false);
        throw publicError(400, 'There is no previous answer to continue');
      }
      userMessage = previousUserMessage;
    } else {
      userMessage = await insertMessage(conversationId, 'user', content);
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    chatSlot.release(true);
    throw publicError(500, 'Failed to generate response', error);
  }

  refreshPersonaInsightsForUser(user.id).catch((error) => {
    console.warn('[Chat] Failed to refresh persona insights:', toSafeError(error, request.requestId));
  });
  if (!request.continueGeneration && conversation.title === 'New Chat') {
    void generateConversationTitle(conversationId, content);
  }
  touchConversation(conversationId, user.id).catch((error) => {
    console.warn('[Chat] Failed to update conversation timestamp:', toSafeError(error, request.requestId));
  });

  let streamStarted = false;
  let failed = false;
  const streamAbortController = new AbortController();
  const responseStream = new PassThrough();
  const sse = new SseWriter(responseStream);
  let chatSlotReleased = false;
  const releaseChatSlot = (failed = false) => {
    if (chatSlotReleased) return;
    chatSlotReleased = true;
    chatSlot.release(failed);
  };
  let upstreamAborted = false;
  const abortUpstreamStream = () => {
    if (upstreamAborted || streamAbortController.signal.aborted) return;
    upstreamAborted = true;
    streamAbortController.abort();
    // Agent execution is intentionally detached from the request stream. A
    // disconnected browser should release the HTTP stream slot immediately;
    // the Agent run keeps its own DB/in-process lifecycle and can be cancelled
    // explicitly through /agent-runs/:id/cancel.
    if (conversation.agent_id) releaseChatSlot(false);
  };

  request.connection.once('aborted', abortUpstreamStream);
  responseStream.once('close', abortUpstreamStream);
  if (isChatConnectionClosed(request, responseStream)) abortUpstreamStream();

  void (async () => {
  try {
    if (streamAbortController.signal.aborted) return;
    const model = conversation.model || getDefaultChatModel();

    if (!sse.open()) return;
    streamStarted = true;

    await sse.send({ userMessageId: userMessage.id });

    if (conversation.agent_id) {
      const agentExecutionController = new AbortController();
      const queued = await agentRunService.execute({
        userId: user.id,
        agentId: conversation.agent_id,
        conversationId,
        projectSpaceId: conversation.project_space_id,
        userMessageId: userMessage.id,
        question: content,
        executionMode: 'queued',
        signal: agentExecutionController.signal,
        requestId: request.requestId,
        emit: async (event) => {
          if (sse.isClosed) return false;
          try {
            return await sse.send(event);
          } catch {
            return false;
          }
        },
      });
      await sse.send({
        assistantMessageId: queued.assistantMessage.id,
        agentRunId: queued.runId,
        agentEvent: { type: 'run.queued', runId: queued.runId },
      });
      agentRecoveryQueue.trigger();
      await sse.done();
      sse.close();
      return;
    }

    const temperature = conversation.temperature !== undefined && conversation.temperature !== null
      ? conversation.temperature
      : 0.7;
    const systemPrompt = conversation.system_prompt || 'You are a helpful AI assistant.';
    const personaProfile = await getPersonaPromptContextForUser(user.id);
    const personalizedSystemPrompt = buildPersonalizedSystemPrompt(systemPrompt, personaProfile);
    const enableRag = conversation.enable_rag !== undefined ? conversation.enable_rag : true;
    // Continue is not a new question. Its payload is an instruction ("continue
    // from where you stopped"), so triggering retrieval on that text produces
    // unrelated evidence or a bogus "insufficient evidence" refusal. Continue
    // extends the existing answer from history alone.
    const shouldRunRag = enableRag
      && !request.continueGeneration
      && shouldUseRagForMessage(content);
    const history = await listRecentMessages(conversationId, 10);

    let contextText = '';
    let assistantSources: ChatSource[] = [];
    let verificationSources: ChatSource[] = [];
    let agenticRagRun: AgenticRagResponse | null = null;
    let traceSummary: RagTraceSummary | null = null;
    let insufficientEvidence = false;
    let answerGuidance = '';

    // Only report "RAG skipped" for a real question. A continuation reuses the
    // evidence of the answer it extends, so the badge would be misleading.
    if (enableRag && !shouldRunRag && !request.continueGeneration) {
      await sse.send({ ragSkipped: true });
    }

    if (shouldRunRag) {
      try {
        const preparedAnswer = await prepareGroundedAnswer({
          question: content,
          userId: user.id,
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
        console.warn('[Chat] RAG retrieval failed; answer generation stopped:', toSafeError(error, request.requestId));
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
        signal: AbortSignal.any([
          streamAbortController.signal,
          AbortSignal.timeout(CHAT_MODEL_TIMEOUT_MS),
        ]),
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
          userId: user.id,
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
          console.warn('[Chat] Failed to persist RAG trace:', toSafeError(error, request.requestId));
        });
      }
      await sse.send({ assistantMessageId: assistantMessage.id });
    }

    await sse.done();
    sse.close();
  } catch (error) {
    if (error instanceof Error && error.message === 'AGENT_RUN_CANCELLED_BEFORE_START') {
      // The explicit conversation stop won the creation race. There is no Run
      // to fail and no generic chat error to show; the user's stop is the
      // terminal outcome for this message.
      sse.close();
      return;
    }
    failed = !streamAbortController.signal.aborted;
    if (streamAbortController.signal.aborted) {
      sse.close();
      return;
    }
    console.error('[Chat] Failed to generate response:', toSafeError(error, request.requestId));
    const agentRunLimit = error instanceof Error && error.message === 'AGENT_ACTIVE_RUN_LIMIT';
    if (streamStarted && !sse.isClosed) {
      if (agentRunLimit) {
        await sse.send({
          error: {
            code: 'agent_run_limit',
            message: 'Too many active Agent runs. Try again after one finishes.',
            retryable: true,
          },
        });
      } else {
        await sse.send({
          error: {
            code: 'chat_stream_failed',
            message: 'Failed to generate response',
            retryable: true,
          },
        });
      }
      sse.close();
    } else if (
      error instanceof ModelProviderConfigurationError
      || error instanceof UnsupportedOfficialModelError
    ) {
      console.warn('[Chat] Model provider rejected stream startup:', toSafeError(error, request.requestId));
      sse.close();
    }
  } finally {
    request.connection.off('aborted', abortUpstreamStream);
    responseStream.off('close', abortUpstreamStream);
    releaseChatSlot(failed);
  }
  })();

  return httpResponse(new StreamableFile(responseStream), {
    headers: SSE_HEADERS,
  });
};

@Injectable()
export class ChatStreamService {
  constructor(private readonly agentRunService: AgentRunService) {}

  sendMessage(request: ChatStreamRequest) {
    return createChatStream(request, this.agentRunService);
  }
}

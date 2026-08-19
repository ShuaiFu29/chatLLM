import type { Message, RagQualitySummary, RagTraceSummary } from './chatStore.types';
import type { AgentEvent } from '../features/agents/types';

export interface ChatSseData {
  userMessageId?: string;
  assistantMessageId?: string;
  content?: string;
  sources?: Message['sources'];
  ragRunId?: string;
  traceSummary?: RagTraceSummary;
  qualitySummary?: RagQualitySummary;
  ragSkipped?: boolean;
  rag_warning?: boolean;
  ragError?: unknown;
  agentRunId?: string;
  agentEvent?: AgentEvent;
  error?: unknown;
}

export interface ChatStreamErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export class ChatStreamError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(payload: ChatStreamErrorPayload) {
    super(payload.message);
    this.name = 'ChatStreamError';
    this.code = payload.code;
    this.retryable = payload.retryable;
  }
}

export const readChatStreamError = (data: ChatSseData) => {
  const rawError = data.error ?? data.ragError;
  if (!rawError) return null;

  if (typeof rawError === 'string') {
    return new ChatStreamError({
      code: 'chat_stream_failed',
      message: rawError,
      retryable: true,
    });
  }
  if (typeof rawError !== 'object') return null;

  const candidate = rawError as Record<string, unknown>;
  const isRagError = Boolean(data.ragError);
  return new ChatStreamError({
    code: typeof candidate.code === 'string' && candidate.code
      ? candidate.code
      : isRagError ? 'rag_retrieval_unavailable' : 'chat_stream_failed',
    message: typeof candidate.message === 'string' && candidate.message
      ? candidate.message
      : isRagError
        ? 'Workspace document retrieval failed. Retry before relying on an answer.'
        : 'Failed to generate response',
    retryable: candidate.retryable !== false,
  });
};

export const readHttpChatError = async (response: Response) => {
  let message = response.statusText || `Chat request failed (${response.status})`;
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string' && body.error) message = body.error;
    if (
      body.error
      && typeof body.error === 'object'
      && typeof (body.error as { message?: unknown }).message === 'string'
    ) {
      message = (body.error as { message: string }).message;
    }
  } catch {
    // The status text remains the safe fallback for non-JSON responses.
  }

  return new ChatStreamError({
    code: `chat_http_${response.status}`,
    message,
    retryable: response.status === 429 || response.status >= 500,
  });
};

import { create, type StoreApi } from 'zustand';
import api, { authenticatedFetch } from '../lib/api';
import { agentRunStatusFromEvent, isMessageAgentRunRecoverable } from '../lib/agentRunRecovery';
import { toSafeError } from '../lib/safeError';
import i18n from '../i18n';
import { chatRequestState } from './chatRequestState';
import { RequestGenerationGuard } from './requestGeneration';
import type {
  ChatState,
  Conversation,
  ConversationComparison,
  Message,
  MessagePageInfo,
} from './chatStore.types';
import type { AgentRunDetail } from '../features/agents/types';
import {
  ChatStreamError,
  readChatStreamError,
  readHttpChatError,
  type ChatSseData,
} from './chatStream';

export type {
  ChatSource,
  Conversation,
  ConversationComparison,
  Message,
  MessagePageInfo,
  RagQualitySummary,
  RagTraceStep,
  RagTraceSummary,
} from './chatStore.types';
export { ChatStreamError } from './chatStream';

const DEFAULT_MESSAGE_PAGE_LIMIT = 100;
const TERMINAL_AGENT_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

type ResponseHeaders = {
  get?: (name: string) => unknown;
  [key: string]: unknown;
};

const readResponseHeader = (headers: ResponseHeaders, name: string) => {
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  if (Array.isArray(value)) return value[0] ? String(value[0]) : '';
  return value === undefined || value === null ? '' : String(value);
};

const readMessagePageInfo = (headers: ResponseHeaders): MessagePageInfo => ({
  hasMore: readResponseHeader(headers, 'x-chatllm-has-more') === 'true',
  nextCursor: readResponseHeader(headers, 'x-chatllm-next-cursor') || null,
  limit: Number.parseInt(readResponseHeader(headers, 'x-chatllm-page-limit'), 10) || DEFAULT_MESSAGE_PAGE_LIMIT,
});

const mergeMessagePages = (olderMessages: Message[], currentMessages: Message[]) => {
  const seen = new Set<string>();
  const merged: Message[] = [];

  [...olderMessages, ...currentMessages].forEach((message) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    merged.push(message);
  });

  return merged;
};

type ChatSet = StoreApi<ChatState>['setState'];

const getConversationMessages = (state: ChatState, conversationId: string) => (
  state.messagesCache[conversationId]
  || (state.currentConversationId === conversationId ? state.messages : [])
);

const updateConversationMessages = (
  set: ChatSet,
  conversationId: string,
  update: (messages: Message[]) => Message[],
) => {
  let generation = chatRequestState.getCacheGeneration(conversationId);
  set((state) => {
    const currentMessages = getConversationMessages(state, conversationId);
    const nextMessages = update(currentMessages);
    if (nextMessages === currentMessages) return {};

    generation = chatRequestState.bumpCacheGeneration(conversationId);
    return {
      messages: state.currentConversationId === conversationId ? nextMessages : state.messages,
      messagesCache: {
        ...state.messagesCache,
        [conversationId]: nextMessages,
      },
    };
  });
  return generation;
};

const replaceConversationMessages = (
  set: ChatSet,
  conversationId: string,
  messages: Message[],
) => updateConversationMessages(set, conversationId, () => messages);

let optimisticMessageSequence = 0;

/**
 * Ids for messages that only exist in the browser.
 *
 * These used to be bare `Date.now()` numbers, which the UI could not tell apart
 * from a real message id: the branch action happily posted a numeric id that no
 * conversation contained. The `temp-` prefix is the single marker for "not
 * persisted yet", matching the optimistic conversation ids.
 */
const createOptimisticMessageId = (role: 'user' | 'assistant') => {
  optimisticMessageSequence += 1;
  return `temp-${role}-${Date.now()}-${optimisticMessageSequence}`;
};

export const isOptimisticMessageId = (id: string) => (
  id.startsWith('temp-') || id.startsWith('welcome-')
);

const isAbortError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError'
    || candidate.name === 'CanceledError'
    || candidate.code === 'ERR_CANCELED';
};

const fetchConversationMessages = async (
  conversationId: string,
  set: ChatSet,
) => {
  const ticket = chatRequestState.beginMessageFetch(conversationId);
  try {
    const res = await api.get(`/chat/conversations/${conversationId}/messages`, {
      params: { limit: DEFAULT_MESSAGE_PAGE_LIMIT },
      signal: ticket.controller.signal,
    });
    if (!chatRequestState.isCurrentMessageFetch(ticket)) return false;
    if (chatRequestState.getCacheGeneration(conversationId) !== ticket.cacheGeneration) {
      return false;
    }

    replaceConversationMessages(set, conversationId, res.data);
    const pageInfo = readMessagePageInfo(res.headers as ResponseHeaders);
    set((state) => ({
      messagePagination: {
        ...state.messagePagination,
        [conversationId]: pageInfo,
      },
      ...(state.currentConversationId === conversationId ? { messagesError: false } : {}),
    }));
    return true;
  } catch (error) {
    if (!isAbortError(error)) {
      console.error('Failed to fetch messages:', toSafeError(error));
      // Surface the failure instead of letting an empty list masquerade as a
      // brand new conversation. Any already cached messages are kept.
      set((state) => (
        state.currentConversationId === conversationId ? { messagesError: true } : {}
      ));
    }
    return false;
  } finally {
    const wasCurrent = chatRequestState.isCurrentMessageFetch(ticket);
    chatRequestState.finishMessageFetch(ticket);
    if (wasCurrent) {
      set((state) => (
        state.currentConversationId === conversationId
          ? { loadingMessages: false }
          : {}
      ));
    }
  }
};

const conversationListRequestGuard = new RequestGenerationGuard();
const invalidateConversationList = (set: ChatSet) => {
  conversationListRequestGuard.abort('conversations');
  set({ loadingConversations: false });
};

const initialChatState = {
  conversations: [] as Conversation[],
  currentConversationId: null,
  messages: [] as Message[],
  messagesCache: {} as Record<string, Message[]>,
  messagePagination: {} as Record<string, MessagePageInfo>,
  loadingConversations: false,
  loadingMessages: false,
  loadingOlderMessages: false,
  messagesError: false,
  sendingMessage: false,
  isStopped: false,
  abortController: null,
};

export const useChatStore = create<ChatState>((set, get) => ({
  ...initialChatState,

  fetchConversations: async (options = { includeArchived: true }) => {
    const ticket = conversationListRequestGuard.begin('conversations');
    set({ loadingConversations: true });
    try {
      const res = await api.get('/chat/conversations', {
        params: { includeArchived: options.includeArchived },
        signal: ticket.controller.signal,
      });
      if (conversationListRequestGuard.isCurrent(ticket)) set({ conversations: res.data });
    } catch (err) {
      if (conversationListRequestGuard.isCurrent(ticket) && !isAbortError(err)) {
        console.error('Failed to fetch conversations:', toSafeError(err));
      }
    } finally {
      if (conversationListRequestGuard.finish(ticket)) set({ loadingConversations: false });
    }
  },

  createConversation: async (title?: string, settings?: Partial<Conversation>) => {
    invalidateConversationList(set);
    // Optimistic Update
    const tempId = 'temp-' + Date.now();
    const tempConv: Conversation = {
      id: tempId,
      project_space_id: settings?.project_space_id,
      title: title || i18n.t('sidebar.newChat'),
      is_pinned: false,
      is_favorite: false,
      tags: [],
      note: '',
      archived_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Optimistically add a welcome message to the cache so it feels instant
    // Note: The real welcome message will come from server, but we can show a placeholder or just empty
    const optimisticWelcomeMsg: Message = {
      id: 'welcome-' + tempId,
      role: 'assistant',
      content: i18n.t('common.loading'),
      created_at: new Date().toISOString()
    };

    set((state) => ({
      conversations: [tempConv, ...state.conversations],
      currentConversationId: tempId,
      messages: [optimisticWelcomeMsg],
      loadingMessages: false,
      loadingOlderMessages: false,
      sendingMessage: false,
      isStopped: false,
      abortController: null,
      messagesCache: { ...state.messagesCache, [tempId]: [optimisticWelcomeMsg] },
      messagePagination: {
        ...state.messagePagination,
        [tempId]: { hasMore: false, nextCursor: null, limit: DEFAULT_MESSAGE_PAGE_LIMIT }
      }
    }));

    try {
      const res = await api.post('/chat/conversations', {
        title,
        project_space_id: settings?.project_space_id,
        agent_id: settings?.agent_id,
      });
      const newConv = res.data;

      invalidateConversationList(set);
      set((state) => {
        // Replace temp conversation with real one
        const hasTempConversation = state.conversations.some((conversation) => conversation.id === tempId);
        const newConversations = hasTempConversation
          ? state.conversations.map(c => c.id === tempId ? newConv : c)
          : [newConv, ...state.conversations.filter((conversation) => conversation.id !== newConv.id)];

        // Migrate cache
        const newCache = { ...state.messagesCache };
        if (newCache[tempId]) {
          newCache[newConv.id] = newCache[tempId];
          delete newCache[tempId];
        }
        const newPagination = { ...state.messagePagination };
        newPagination[newConv.id] = newPagination[tempId] || {
          hasMore: false,
          nextCursor: null,
          limit: DEFAULT_MESSAGE_PAGE_LIMIT
        };
        delete newPagination[tempId];

        return {
          conversations: newConversations,
          currentConversationId: state.currentConversationId === tempId ? newConv.id : state.currentConversationId,
          messagesCache: newCache,
          messagePagination: newPagination
        };
      });

      // Load the real welcome message before returning. Fire-and-forget here
      // raced with the caller's first `sendMessage`: the late response replaced
      // the optimistic user message and streaming placeholder with the server's
      // welcome-only history.
      await get().selectConversation(newConv.id);

      return newConv.id;
    } catch (err) {
      console.error('Failed to create conversation:', toSafeError(err));
      // Rollback
      set((state) => ({
        conversations: state.conversations.filter(c => c.id !== tempId),
        currentConversationId: state.currentConversationId === tempId ? null : state.currentConversationId
      }));
      throw err;
    }
  },

  renameConversation: async (id: string, title: string) => {
    invalidateConversationList(set);
    const previousConversations = get().conversations;

    // Optimistic Update
    set((state) => ({
      conversations: state.conversations.map(c =>
        c.id === id ? { ...c, title } : c
      )
    }));

    try {
      await api.patch(`/chat/conversations/${id}`, { title });
      invalidateConversationList(set);
      set((state) => ({
        conversations: state.conversations.map((conversation) => (
          conversation.id === id ? { ...conversation, title } : conversation
        )),
      }));
    } catch (err) {
      console.error('Failed to rename conversation:', toSafeError(err));
      // Rollback
      set({ conversations: previousConversations });
    }
  },

  updateConversation: async (id: string, updates: Partial<Conversation>) => {
    invalidateConversationList(set);
    const previousConversations = get().conversations;

    // Optimistic Update
    set((state) => ({
      conversations: state.conversations.map(c =>
        c.id === id ? { ...c, ...updates } : c
      ),
      // Also update current conversation if it's the one being updated
      // This ensures components like ChatPage get the latest settings immediately
      currentConversationId: state.currentConversationId
    }));

    try {
      await api.patch(`/chat/conversations/${id}`, updates);
      invalidateConversationList(set);
      set((state) => ({
        conversations: state.conversations.map((conversation) => (
          conversation.id === id ? { ...conversation, ...updates } : conversation
        )),
      }));
    } catch (err) {
      console.error('Failed to update conversation:', toSafeError(err));
      // Rollback
      set({ conversations: previousConversations });
      throw err;
    }
  },

  toggleConversationPinned: async (id: string) => {
    const conversation = get().conversations.find(c => c.id === id);
    if (!conversation) return;

    await get().updateConversation(id, { is_pinned: !conversation.is_pinned });
  },

  toggleConversationFavorite: async (id: string) => {
    const conversation = get().conversations.find(c => c.id === id);
    if (!conversation) return;

    await get().updateConversation(id, { is_favorite: !conversation.is_favorite });
  },

  branchConversation: async (conversationId: string, messageId?: string) => {
    try {
      const res = await api.post<Conversation>(`/chat/conversations/${conversationId}/branches`, {
        messageId,
      });
      const branch = res.data;

      invalidateConversationList(set);
      set((state) => ({
        conversations: [branch, ...state.conversations.filter(c => c.id !== branch.id)],
        currentConversationId: branch.id,
        messages: [],
      }));

      await get().selectConversation(branch.id);
      return branch.id;
    } catch (err) {
      console.error('Failed to branch conversation:', toSafeError(err));
      return null;
    }
  },

  compareConversations: async (conversationId: string, otherConversationId: string) => {
    try {
      const res = await api.get<ConversationComparison>(
        `/chat/conversations/${conversationId}/compare/${otherConversationId}`
      );
      return res.data;
    } catch (err) {
      console.error('Failed to compare conversations:', toSafeError(err));
      return null;
    }
  },

  archiveConversation: async (id: string) => {
    invalidateConversationList(set);
    const previousConversations = get().conversations;
    const previousCurrentId = get().currentConversationId;
    const previousMessages = get().messages;
    const archivedAt = new Date().toISOString();

    set((state) => ({
      currentConversationId: state.currentConversationId === id ? null : state.currentConversationId,
      messages: state.currentConversationId === id ? [] : state.messages,
      conversations: state.conversations.map(c =>
        c.id === id ? { ...c, archived_at: archivedAt, is_pinned: false } : c
      )
    }));

    try {
      await api.patch(`/chat/conversations/${id}`, { archived: true, is_pinned: false });
      invalidateConversationList(set);
      set((state) => ({
        conversations: state.conversations.map((conversation) => (
          conversation.id === id
            ? { ...conversation, archived_at: archivedAt, is_pinned: false }
            : conversation
        )),
      }));
    } catch (err) {
      console.error('Failed to archive conversation:', toSafeError(err));
      set({
        currentConversationId: previousCurrentId,
        conversations: previousConversations,
        messages: previousMessages
      });
    }
  },

  unarchiveConversation: async (id: string) => {
    invalidateConversationList(set);
    const previousConversations = get().conversations;

    set((state) => ({
      conversations: state.conversations.map(c =>
        c.id === id ? { ...c, archived_at: null } : c
      )
    }));

    try {
      await api.patch(`/chat/conversations/${id}`, { archived: false });
      invalidateConversationList(set);
      set((state) => ({
        conversations: state.conversations.map((conversation) => (
          conversation.id === id ? { ...conversation, archived_at: null } : conversation
        )),
      }));
    } catch (err) {
      console.error('Failed to unarchive conversation:', toSafeError(err));
      set({ conversations: previousConversations });
    }
  },

  deleteConversation: async (id: string) => {
    invalidateConversationList(set);
    const previousConversations = get().conversations;
    const previousCurrentId = get().currentConversationId;
    const deletedConversationIndex = previousConversations.findIndex((conversation) => (
      conversation.id === id
    ));
    const deletedConversation = previousConversations[deletedConversationIndex];
    const previousMessages = previousCurrentId === id
      ? get().messages
      : get().messagesCache[id] || [];

    // Optimistic Update
    set((state) => ({
      conversations: state.conversations.filter(c => c.id !== id),
      currentConversationId: state.currentConversationId === id ? null : state.currentConversationId,
      messages: state.currentConversationId === id ? [] : state.messages,
      loadingMessages: state.currentConversationId === id ? false : state.loadingMessages,
      loadingOlderMessages: state.currentConversationId === id ? false : state.loadingOlderMessages,
      sendingMessage: state.currentConversationId === id ? false : state.sendingMessage,
      isStopped: state.currentConversationId === id ? false : state.isStopped,
      abortController: state.currentConversationId === id ? null : state.abortController,
    }));

    try {
      await api.delete(`/chat/conversations/${id}`);
      invalidateConversationList(set);
      chatRequestState.clearConversation(id);
      // Remove from cache
      set((state) => {
        const newCache = { ...state.messagesCache };
        const newPagination = { ...state.messagePagination };
        delete newCache[id];
        delete newPagination[id];
        return {
          conversations: state.conversations.filter((conversation) => conversation.id !== id),
          messagesCache: newCache,
          messagePagination: newPagination,
        };
      });
    } catch (err) {
      console.error('Failed to delete conversation:', toSafeError(err));
      set((state) => {
        let conversations = state.conversations;
        if (deletedConversation && !conversations.some((conversation) => conversation.id === id)) {
          conversations = [...conversations];
          conversations.splice(
            Math.min(Math.max(deletedConversationIndex, 0), conversations.length),
            0,
            deletedConversation,
          );
        }

        const shouldRestoreSelection = previousCurrentId === id
          && state.currentConversationId === null;
        if (!shouldRestoreSelection) return { conversations };

        return {
          conversations,
          currentConversationId: id,
          messages: state.messagesCache[id] || previousMessages,
          loadingMessages: chatRequestState.isLoadingMessages(id),
          loadingOlderMessages: chatRequestState.isLoadingOlderMessages(id),
          sendingMessage: chatRequestState.hasActiveStream(id),
          isStopped: chatRequestState.isStopped(id),
          abortController: chatRequestState.getStreamController(id),
        };
      });
    }
  },

  deleteMessage: async (messageId: string) => {
    const conversationId = get().currentConversationId;
    if (!conversationId) return;
    const previousMessages = getConversationMessages(get(), conversationId);

    // Optimistic Update
    const optimisticGeneration = updateConversationMessages(
      set,
      conversationId,
      (messages) => messages.filter((item) => item.id !== messageId),
    );

    try {
      await api.delete(`/chat/messages/${messageId}`);
    } catch (err) {
      console.error('Failed to delete message:', toSafeError(err));
      if (chatRequestState.getCacheGeneration(conversationId) === optimisticGeneration) {
        replaceConversationMessages(set, conversationId, previousMessages);
      } else {
        await fetchConversationMessages(conversationId, set);
      }
    }
  },

  regenerateMessage: async () => {
    const conversationId = get().currentConversationId;
    if (!conversationId) return;
    const messages = getConversationMessages(get(), conversationId);
    const { sendMessage } = get();
    if (messages.length === 0) return;

    // Find the last user message to use as trigger
    // If the last message is assistant, we delete it first (in UI logic or here)
    // Actually, regenerate usually means "regenerate the last assistant response"

    let lastUserMessageIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserMessageIndex = i;
        break;
      }
    }

    if (lastUserMessageIndex === -1) return;

    const lastUserMessage = messages[lastUserMessageIndex];

    try {
      await api.delete(
        `/chat/conversations/${conversationId}/messages/${lastUserMessage.id}/truncate`,
      );
    } catch (e) {
      console.error('Failed to truncate conversation for regeneration:', toSafeError(e));
      return;
    }

    updateConversationMessages(set, conversationId, (currentMessages) => {
      const selectedIndex = currentMessages.findIndex((message) => message.id === lastUserMessage.id);
      return selectedIndex === -1 ? currentMessages : currentMessages.slice(0, selectedIndex);
    });
    await sendMessage(lastUserMessage.content, false, conversationId);
  },

  stopGeneration: () => {
    const conversationId = get().currentConversationId;
    if (!conversationId || !chatRequestState.stopStream(conversationId)) return;
    const activeAssistant = [...getConversationMessages(get(), conversationId)]
      .reverse()
      .find((message) => message.role === 'assistant');
    const activeAgentRunId = activeAssistant?.agentRunId || activeAssistant?.agent_run_id;
    void (activeAgentRunId
      ? api.post(`/agent-runs/${activeAgentRunId}/cancel`, {})
      : api.post(`/agent-runs/conversations/${conversationId}/cancel`, {}))
      .catch(() => undefined);
    // Remove the local numeric placeholder immediately. The server persists a
    // terminal Agent message when possible; re-fetching reconciles either that
    // message or a partially generated regular answer.
    updateConversationMessages(set, conversationId, (messages) => {
      const last = messages.at(-1);
      if (last?.role !== 'assistant' || !last.id.startsWith('temp-assistant-')) return messages;
      return messages.slice(0, -1);
    });
    set({
      sendingMessage: false,
      isStopped: true,
      abortController: null,
    });
    void fetchConversationMessages(conversationId, set);
  },

  continueGeneration: async () => {
    const { messages, sendMessage } = get();
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];

    // Only continue if the last message is from assistant
    if (lastMsg.role !== 'assistant') return;

    // The server receives an explicit continue marker, so this prompt is not
    // persisted as a hidden user message.
    // Improved Prompt: Quote the last few characters to guide the LLM
    const lastChars = lastMsg.content.slice(-50).replace(/\n/g, ' '); // Get last 50 chars, flatten newlines
    const prompt = `Please continue your response. You stopped at: "...${lastChars}". Continue exactly from there, do not repeat the context.`;

    await sendMessage(prompt, true);
  },

  selectConversation: async (id: string) => {
    const { messagesCache } = get();
    const cachedMessages = messagesCache[id];
    const activeController = chatRequestState.getStreamController(id);

    // 1. Cache First
    set({
      currentConversationId: id,
      messages: cachedMessages || [],
      loadingMessages: !cachedMessages,
      loadingOlderMessages: chatRequestState.isLoadingOlderMessages(id),
      messagesError: false,
      sendingMessage: chatRequestState.hasActiveStream(id),
      isStopped: chatRequestState.isStopped(id),
      abortController: activeController,
    });

    if (activeController && cachedMessages) return;
    await fetchConversationMessages(id, set);
  },

  refreshMessages: async (id?: string) => {
    const conversationId = id || get().currentConversationId;
    if (!conversationId) return false;
    return fetchConversationMessages(conversationId, set);
  },

  refreshAgentRunDetails: async (id?: string) => {
    const conversationId = id || get().currentConversationId;
    if (!conversationId) return false;
    const runIds = [...new Set(
      getConversationMessages(get(), conversationId)
        .filter(isMessageAgentRunRecoverable)
        .map((message) => message.agentRunId || message.agent_run_id)
        .filter((runId): runId is string => Boolean(runId)),
    )];
    if (runIds.length === 0) return false;

    const results = await Promise.all(runIds.map(async (runId) => {
      try {
        const response = await api.get<AgentRunDetail>(`/agent-runs/${runId}`, {
          params: { stepLimit: 500, approvalLimit: 200 },
        });
        return response.data;
      } catch (error) {
        console.error('Failed to refresh Agent run detail:', toSafeError(error));
        return null;
      }
    }));
    const details = new Map(results
      .filter((detail): detail is AgentRunDetail => Boolean(detail))
      .map((detail) => [detail.id, detail]));
    if (details.size === 0) return false;

    const streamActive = chatRequestState.hasActiveStream(conversationId);
    updateConversationMessages(set, conversationId, (messages) => messages.map((message) => {
      const runId = message.agentRunId || message.agent_run_id;
      const detail = runId ? details.get(runId) : undefined;
      if (!detail) return message;
      // The database can reach terminal just before the final SSE frame. Keep
      // the browser's active marker until that frame arrives; if the stream
      // drops, the ordinary message-recovery poll will then fetch the persisted
      // final answer instead of mistaking the empty placeholder for completion.
      const preserveLiveStatus = streamActive
        && TERMINAL_AGENT_RUN_STATUSES.has(detail.status)
        && isMessageAgentRunRecoverable(message);
      return {
        ...message,
        agent_run_status: preserveLiveStatus ? message.agent_run_status : detail.status,
        agent_grounding: detail.grounding,
        agent_steps: detail.steps,
        agent_approvals: detail.approvals,
      };
    }));
    return true;
  },

  loadOlderMessages: async (id?: string) => {
    const conversationId = id || get().currentConversationId;
    if (!conversationId) return;

    const pageInfo = get().messagePagination[conversationId];
    if (!pageInfo?.hasMore || !pageInfo.nextCursor) return;
    const ticket = chatRequestState.beginOlderMessagesFetch(conversationId);
    if (!ticket) return;

    set((state) => (
      state.currentConversationId === conversationId
        ? { loadingOlderMessages: true }
        : {}
    ));

    try {
      const res = await api.get(`/chat/conversations/${conversationId}/messages`, {
        params: {
          limit: pageInfo.limit || DEFAULT_MESSAGE_PAGE_LIMIT,
          cursor: pageInfo.nextCursor,
        },
        signal: ticket.controller.signal,
      });
      if (!chatRequestState.isCurrentOlderMessagesFetch(ticket)) return;
      const nextPageInfo = readMessagePageInfo(res.headers as ResponseHeaders);

      updateConversationMessages(
        set,
        conversationId,
        (currentMessages) => mergeMessagePages(res.data, currentMessages),
      );
      set((state) => ({
        messagePagination: {
          ...state.messagePagination,
          [conversationId]: nextPageInfo,
        },
      }));
    } catch (err) {
      if (!isAbortError(err)) {
        console.error('Failed to load older messages:', toSafeError(err));
      }
    } finally {
      const wasCurrent = chatRequestState.isCurrentOlderMessagesFetch(ticket);
      chatRequestState.finishOlderMessagesFetch(ticket);
      if (wasCurrent) {
        set((state) => (
          state.currentConversationId === conversationId
            ? { loadingOlderMessages: false }
            : {}
        ));
      }
    }
  },

  sendMessage: async (content: string, isContinue = false, targetConversationId?: string) => {
    const currentConversationId = targetConversationId || get().currentConversationId;
    if (!currentConversationId) return;
    const messages = getConversationMessages(get(), currentConversationId);

    const abortController = chatRequestState.beginStream(currentConversationId);
    set((state) => (
      state.currentConversationId === currentConversationId
        ? { sendingMessage: true, abortController, isStopped: false }
        : {}
    ));

    let tempUserId = '';
    let tempAiId = '';
    let streamEstablished = false;
    let persistedAssistantMessageId = false;
    let activeAgentRunId: string | null = null;

    // Continue creates a fresh assistant placeholder without creating a user
    // message. The server uses the explicit continue marker to keep the
    // prompt out of persisted history.
    if (isContinue) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'assistant') {
        tempAiId = createOptimisticMessageId('assistant');
        replaceConversationMessages(
          set,
          currentConversationId,
          [...messages, {
            id: tempAiId,
            role: 'assistant',
            content: '',
            created_at: new Date().toISOString(),
          }],
        );
      } else {
        // Fallback if somehow last msg is not assistant
        isContinue = false;
      }
    }

    if (!isContinue) {
      // 1. Optimistic User Message
      tempUserId = createOptimisticMessageId('user');
      const optimisticUserMsg: Message = {
        id: tempUserId,
        role: 'user',
        content,
        created_at: new Date().toISOString()
      };

      // 2. Placeholder AI Message
      tempAiId = createOptimisticMessageId('assistant');
      const optimisticAiMsg: Message = {
        id: tempAiId,
        role: 'assistant',
        content: '',
        created_at: new Date().toISOString()
      };

      replaceConversationMessages(
        set,
        currentConversationId,
        [...messages, optimisticUserMsg, optimisticAiMsg],
      );
    }

    const updateMessages = (newMessages: Message[]) => {
      replaceConversationMessages(set, currentConversationId, newMessages);
    };

    const rollbackFailedAssistant = (removeOptimisticUser: boolean) => {
      const currentMsgs = getConversationMessages(get(), currentConversationId);
      // An Agent run outlives its SSE stream on purpose. Dropping the assistant
      // placeholder here would also drop the `agentRunId` and event list, which
      // is the only evidence the chat page has to resume polling after the
      // connection breaks.
      const keepForRecovery = currentMsgs.some((message) => (
        message.id === tempAiId && isMessageAgentRunRecoverable(message)
      ));
      if (keepForRecovery) return;
      updateMessages(currentMsgs.filter((message) => (
        message.id !== tempAiId
        && (!removeOptimisticUser || message.id !== tempUserId)
      )));
    };

    try {
      const response = await authenticatedFetch(`/api/chat/conversations/${currentConversationId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // 'include' tells the browser to send cookies even for cross-origin calls (if CORS allows),
        // or same-origin calls.
        credentials: 'include',
        body: JSON.stringify(isContinue ? { content, continue: true } : { content }),
        signal: abortController.signal
      });

      if (!response.ok) {
        throw await readHttpChatError(response);
      }

      if (!response.body) {
        throw new ChatStreamError({
          code: 'chat_stream_unavailable',
          message: 'Chat response stream is unavailable',
          retryable: true,
        });
      }

      streamEstablished = true;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiContent = isContinue ? (messages.find(m => m.id === tempAiId)?.content || '') : '';
      let buffer = '';
      let receivedDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (!chatRequestState.isCurrentStream(currentConversationId, abortController)) {
          await reader.cancel().catch(() => undefined);
          return;
        }
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split('\n');

        // Keep the last line in the buffer as it might be incomplete
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim() === '') continue;
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') {
              receivedDone = true;
              continue;
            }

            let data: ChatSseData;
            try {
              data = JSON.parse(dataStr) as ChatSseData;
            } catch (error) {
              console.error('Error parsing SSE data', toSafeError(error));
              continue;
            }

            const streamError = readChatStreamError(data);
            if (streamError) throw streamError;

              if (data.userMessageId && tempUserId) {
                const currentMsgs = getConversationMessages(get(), currentConversationId);
                const lastMsgIndex = currentMsgs.findIndex(m => m.id === tempUserId);
                if (lastMsgIndex !== -1) {
                  const updatedMsgs = [...currentMsgs];
                  updatedMsgs[lastMsgIndex] = {
                    ...updatedMsgs[lastMsgIndex],
                    id: data.userMessageId
                  };
                  tempUserId = data.userMessageId;
                  updateMessages(updatedMsgs);
                }
              }

              if (data.assistantMessageId && tempAiId) {
                persistedAssistantMessageId = true;
                const currentMsgs = getConversationMessages(get(), currentConversationId);
                const lastMsgIndex = currentMsgs.findIndex(m => m.id === tempAiId);
                if (lastMsgIndex !== -1) {
                  const updatedMsgs = [...currentMsgs];
                  updatedMsgs[lastMsgIndex] = {
                    ...updatedMsgs[lastMsgIndex],
                    id: data.assistantMessageId
                  };
                  tempAiId = data.assistantMessageId;
                  updateMessages(updatedMsgs);
                }
              }

              // Handle Sources
              if (data.sources) {
                const currentMsgs = getConversationMessages(get(), currentConversationId);
                const lastMsgIndex = currentMsgs.findIndex(m => m.id === tempAiId);
                if (lastMsgIndex !== -1) {
                  const updatedMsgs = [...currentMsgs];
                  // If continuing, merge sources? For now just replace/add
                  updatedMsgs[lastMsgIndex] = {
                    ...updatedMsgs[lastMsgIndex],
                    sources: data.sources
                  };
                  updateMessages(updatedMsgs);
                }
              }

              if (data.agentRunId || data.agentEvent) {
                activeAgentRunId = data.agentRunId || activeAgentRunId;
                const currentMsgs = getConversationMessages(get(), currentConversationId);
                const lastMsgIndex = currentMsgs.findIndex(m => m.id === tempAiId);
                if (lastMsgIndex !== -1) {
                  const currentMessage = currentMsgs[lastMsgIndex];
                  const updatedMsgs = [...currentMsgs];
                  updatedMsgs[lastMsgIndex] = {
                    ...currentMessage,
                    agentRunId: data.agentRunId || currentMessage.agentRunId,
                    // Mirror the status the messages API would report so a
                    // dropped SSE connection can still be recovered without a
                    // full page reload.
                    agent_run_status: agentRunStatusFromEvent(data.agentEvent?.type)
                      || currentMessage.agent_run_status,
                    agentEvents: data.agentEvent
                      ? [...(currentMessage.agentEvents || []), data.agentEvent]
                      : currentMessage.agentEvents,
                  };
                  updateMessages(updatedMsgs);
                }
              }

              if (data.ragRunId || data.traceSummary || data.qualitySummary) {
                const currentMsgs = getConversationMessages(get(), currentConversationId);
                const lastMsgIndex = currentMsgs.findIndex(m => m.id === tempAiId);
                if (lastMsgIndex !== -1) {
                  const updatedMsgs = [...currentMsgs];
                  updatedMsgs[lastMsgIndex] = {
                    ...updatedMsgs[lastMsgIndex],
                    ragRunId: data.ragRunId || updatedMsgs[lastMsgIndex].ragRunId,
                    traceSummary: data.traceSummary || updatedMsgs[lastMsgIndex].traceSummary,
                    qualitySummary: data.qualitySummary || updatedMsgs[lastMsgIndex].qualitySummary,
                  };
                  updateMessages(updatedMsgs);
                }
              }

              if (data.rag_warning) {
                const currentMsgs = getConversationMessages(get(), currentConversationId);
                const lastMsgIndex = currentMsgs.findIndex(m => m.id === tempAiId);
                if (lastMsgIndex !== -1) {
                  const updatedMsgs = [...currentMsgs];
                  updatedMsgs[lastMsgIndex] = {
                    ...updatedMsgs[lastMsgIndex],
                    ragWarning: true,
                    sources: [],
                    ragRunId: null,
                    traceSummary: null,
                    qualitySummary: null,
                  };
                  updateMessages(updatedMsgs);
                }
              }

              if (data.ragSkipped) {
                const currentMsgs = getConversationMessages(get(), currentConversationId);
                const lastMsgIndex = currentMsgs.findIndex(m => m.id === tempAiId);
                if (lastMsgIndex !== -1) {
                  const updatedMsgs = [...currentMsgs];
                  updatedMsgs[lastMsgIndex] = {
                    ...updatedMsgs[lastMsgIndex],
                    ragSkipped: true,
                    sources: [],
                    ragRunId: null,
                    traceSummary: null,
                    qualitySummary: null,
                  };
                  updateMessages(updatedMsgs);
                }
              }

              // Handle Content
              if (data.content) {
                aiContent += data.content;
                const currentMsgs = getConversationMessages(get(), currentConversationId);
                const lastMsgIndex = currentMsgs.findIndex(m => m.id === tempAiId);
                if (lastMsgIndex !== -1) {
                  const updatedMsgs = [...currentMsgs];
                  updatedMsgs[lastMsgIndex] = {
                    ...updatedMsgs[lastMsgIndex],
                    content: aiContent
                  };
                  updateMessages(updatedMsgs);
                }
              }
          }
        }
      }

      if (!receivedDone) {
        throw new ChatStreamError({
          code: 'chat_stream_incomplete',
          message: 'Chat response ended before completion',
          retryable: true,
        });
      }
      if (!isContinue && !aiContent && !activeAgentRunId) {
        throw new ChatStreamError({
          code: 'chat_stream_empty',
          message: 'Chat response did not contain an answer',
          retryable: true,
        });
      }

      if (chatRequestState.isCurrentStream(currentConversationId, abortController)) {
        get().fetchConversations();
      }

    } catch (err: unknown) {
      if (isAbortError(err)) {
        if (chatRequestState.isStopped(currentConversationId)) {
          void (activeAgentRunId
            ? api.post(`/agent-runs/${activeAgentRunId}/cancel`, {})
            : api.post(`/agent-runs/conversations/${currentConversationId}/cancel`, {}))
            .catch(() => undefined);
        }
        return;
      }
      console.error('Failed to send message:', toSafeError(err));
      if (chatRequestState.isCurrentStream(currentConversationId, abortController)) {
        if (!persistedAssistantMessageId) rollbackFailedAssistant(!streamEstablished);
      }
      throw err;
    } finally {
      const finishedCurrentStream = chatRequestState.finishStream(
        currentConversationId,
        abortController,
      );
      if (finishedCurrentStream) {
        set((state) => (
          state.currentConversationId === currentConversationId
            ? {
              sendingMessage: chatRequestState.hasActiveStream(currentConversationId),
              isStopped: chatRequestState.isStopped(currentConversationId),
              abortController: chatRequestState.getStreamController(currentConversationId),
            }
            : {}
        ));
      }
    }
  },

  reset: () => {
    conversationListRequestGuard.abortAll();
    chatRequestState.reset();
    set(initialChatState);
  },
}));

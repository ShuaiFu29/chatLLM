import { create } from 'zustand';
import api from '../lib/api';

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  model?: string;
  temperature?: number;
  system_prompt?: string;
  enable_rag?: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  sources?: { filename: string; similarity: number }[];
}

interface ChatState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Message[];
  messagesCache: Record<string, Message[]>;
  loadingConversations: boolean;
  loadingMessages: boolean;
  sendingMessage: boolean;
  isStopped: boolean; // Add this
  abortController: AbortController | null;

  fetchConversations: () => Promise<void>;
  createConversation: (title?: string, settings?: Partial<Conversation>) => Promise<string>;
  renameConversation: (id: string, title: string) => Promise<void>;
  updateConversation: (id: string, updates: Partial<Conversation>) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  regenerateMessage: () => Promise<void>;
  stopGeneration: () => void;
  continueGeneration: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  sendMessage: (content: string, isContinue?: boolean) => Promise<void>;
}



export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  messagesCache: {},
  loadingConversations: false,
  loadingMessages: false,
  sendingMessage: false,
  isStopped: false,
  abortController: null,

  fetchConversations: async () => {
    set({ loadingConversations: true });
    try {
      const res = await api.get('/chat/conversations');
      set({ conversations: res.data });
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    } finally {
      set({ loadingConversations: false });
    }
  },

  createConversation: async (title?: string) => {
    // Optimistic Update
    const tempId = 'temp-' + Date.now();
    const tempConv: Conversation = {
      id: tempId,
      title: title || 'New Chat',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Optimistically add a welcome message to the cache so it feels instant
    // Note: The real welcome message will come from server, but we can show a placeholder or just empty
    const optimisticWelcomeMsg: Message = {
      id: 'welcome-' + tempId,
      role: 'assistant',
      content: 'Thinking...', // or just empty
      created_at: new Date().toISOString()
    };

    set((state) => ({
      conversations: [tempConv, ...state.conversations],
      currentConversationId: tempId,
      messages: [optimisticWelcomeMsg],
      messagesCache: { ...state.messagesCache, [tempId]: [optimisticWelcomeMsg] }
    }));

    try {
      const res = await api.post('/chat/conversations', { title });
      const newConv = res.data;

      set((state) => {
        // Replace temp conversation with real one
        const newConversations = state.conversations.map(c =>
          c.id === tempId ? newConv : c
        );

        // Migrate cache
        const newCache = { ...state.messagesCache };
        if (newCache[tempId]) {
          newCache[newConv.id] = newCache[tempId];
          delete newCache[tempId];
        }

        return {
          conversations: newConversations,
          currentConversationId: state.currentConversationId === tempId ? newConv.id : state.currentConversationId,
          messagesCache: newCache
        };
      });

      // Fetch the real welcome message from server
      get().selectConversation(newConv.id);

      return newConv.id;
    } catch (err) {
      console.error('Failed to create conversation:', err);
      // Rollback
      set((state) => ({
        conversations: state.conversations.filter(c => c.id !== tempId),
        currentConversationId: state.currentConversationId === tempId ? null : state.currentConversationId
      }));
      throw err;
    }
  },

  renameConversation: async (id: string, title: string) => {
    const previousConversations = get().conversations;

    // Optimistic Update
    set((state) => ({
      conversations: state.conversations.map(c =>
        c.id === id ? { ...c, title } : c
      )
    }));

    try {
      await api.patch(`/chat/conversations/${id}`, { title });
    } catch (err) {
      console.error('Failed to rename conversation:', err);
      // Rollback
      set({ conversations: previousConversations });
    }
  },

  updateConversation: async (id: string, updates: Partial<Conversation>) => {
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
    } catch (err) {
      console.error('Failed to update conversation:', err);
      // Rollback
      set({ conversations: previousConversations });
    }
  },

  deleteConversation: async (id: string) => {
    const previousConversations = get().conversations;
    const previousCurrentId = get().currentConversationId;

    // Optimistic Update
    set((state) => ({
      conversations: state.conversations.filter(c => c.id !== id),
      currentConversationId: state.currentConversationId === id ? null : state.currentConversationId
    }));

    try {
      await api.delete(`/chat/conversations/${id}`);
      // Remove from cache
      set((state) => {
        const newCache = { ...state.messagesCache };
        delete newCache[id];
        return { messagesCache: newCache };
      });
    } catch (err) {
      console.error('Failed to delete conversation:', err);
      // Rollback
      set({
        conversations: previousConversations,
        currentConversationId: previousCurrentId
      });
    }
  },

  deleteMessage: async (messageId: string) => {
    const previousMessages = get().messages;

    // Optimistic Update
    set((state) => ({
      messages: state.messages.filter(m => m.id !== messageId),
      messagesCache: {
        ...state.messagesCache,
        [state.currentConversationId!]: state.messages.filter(m => m.id !== messageId)
      }
    }));

    try {
      await api.delete(`/chat/messages/${messageId}`);
    } catch (err) {
      console.error('Failed to delete message:', err);
      // Rollback
      set((state) => ({
        messages: previousMessages,
        messagesCache: {
          ...state.messagesCache,
          [state.currentConversationId!]: previousMessages
        }
      }));
    }
  },

  regenerateMessage: async () => {
    const { messages, sendMessage } = get();
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

    // We keep everything up to the last user message
    const historyToKeep = messages.slice(0, lastUserMessageIndex + 1);
    const lastUserMessage = messages[lastUserMessageIndex];

    // Optimistically set messages to history (removing the last user message too, as it will be re-added by sendMessage)
    set((state) => ({
      messages: historyToKeep.slice(0, -1),
      messagesCache: {
        ...state.messagesCache,
        [state.currentConversationId!]: historyToKeep.slice(0, -1)
      }
    }));

    // Identify assistant messages to delete (those after the user message)
    const messagesToDelete = messages.slice(lastUserMessageIndex + 1);

    // Delete them from server asynchronously
    // We don't wait for this to finish to start generating, but we should fire and forget
    messagesToDelete.forEach(m => {
      api.delete(`/chat/messages/${m.id}`).catch(e => console.error('Failed to delete stale message:', e));
    });

    // Also delete the user message from server to avoid duplicates when we re-send it
    // But we MUST keep the content to re-send
    try {
      await api.delete(`/chat/messages/${lastUserMessage.id}`);
    } catch (e) {
      console.error('Failed to delete user message for regen:', e);
    }

    // Trigger sendMessage with the last user content
    // We pass isRegenerate=true to handle this case cleanly if needed, or just standard send
    await sendMessage(lastUserMessage.content);
  },

  stopGeneration: () => {
    const { abortController } = get();
    if (abortController) {
      abortController.abort();
      set({ sendingMessage: false, abortController: null });
    }
  },

  continueGeneration: async () => {
    const { messages, sendMessage } = get();
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];

    // Only continue if the last message is from assistant
    if (lastMsg.role !== 'assistant') return;

    // We send a "Continue" prompt, but we handle it specially in sendMessage
    // to NOT add a new user message, but to append to the assistant message.
    // Improved Prompt: Quote the last few characters to guide the LLM
    const lastChars = lastMsg.content.slice(-50).replace(/\n/g, ' '); // Get last 50 chars, flatten newlines
    const prompt = `Please continue your response. You stopped at: "...${lastChars}". Continue exactly from there, do not repeat the context.`;

    await sendMessage(prompt, true);
  },

  selectConversation: async (id: string) => {
    const { messagesCache } = get();

    // 1. Cache First
    if (messagesCache[id]) {
      set({
        currentConversationId: id,
        messages: messagesCache[id],
        loadingMessages: false
      });
    } else {
      set({ currentConversationId: id, loadingMessages: true, messages: [] });
    }

    try {
      const res = await api.get(`/chat/conversations/${id}/messages`);
      set((state) => ({
        messages: res.data,
        messagesCache: { ...state.messagesCache, [id]: res.data },
        loadingMessages: false
      }));
    } catch (err) {
      console.error('Failed to fetch messages:', err);
      set({ loadingMessages: false });
    }
  },

  sendMessage: async (content: string, isContinue = false) => {
    const { currentConversationId, messages } = get();
    if (!currentConversationId) return;

    // Create AbortController
    const abortController = new AbortController();
    set({ sendingMessage: true, abortController, isStopped: false });

    let tempUserId = '';
    let tempAiId = '';

    // If continue, we don't add user message, and we reuse the last assistant message ID
    if (isContinue) {
      // Find the last assistant message to append to
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'assistant') {
        tempAiId = lastMsg.id;
      } else {
        // Fallback if somehow last msg is not assistant
        isContinue = false;
      }
    }

    if (!isContinue) {
      // 1. Optimistic User Message
      tempUserId = Date.now().toString();
      const optimisticUserMsg: Message = {
        id: tempUserId,
        role: 'user',
        content,
        created_at: new Date().toISOString()
      };

      // 2. Placeholder AI Message
      tempAiId = (Date.now() + 1).toString();
      const optimisticAiMsg: Message = {
        id: tempAiId,
        role: 'assistant',
        content: '',
        created_at: new Date().toISOString()
      };

      const updateMessages = (newMessages: Message[]) => {
        set(state => ({
          messages: newMessages,
          messagesCache: {
            ...state.messagesCache,
            [currentConversationId]: newMessages
          }
        }));
      };

      updateMessages([...messages, optimisticUserMsg, optimisticAiMsg]);
    }

    const updateMessages = (newMessages: Message[]) => {
      set(state => ({
        messages: newMessages,
        messagesCache: {
          ...state.messagesCache,
          [currentConversationId]: newMessages
        }
      }));
    };

    try {
      // Use native fetch for streaming
      // Since we use HttpOnly cookies for auth, we just need to ensure credentials are included.
      const response = await fetch(`/api/chat/conversations/${currentConversationId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // 'include' tells the browser to send cookies even for cross-origin calls (if CORS allows),
        // or same-origin calls.
        credentials: 'include',
        body: JSON.stringify({ content }),
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(response.statusText);
      }

      if (!response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiContent = isContinue ? (messages.find(m => m.id === tempAiId)?.content || '') : '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
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
            if (dataStr === '[DONE]') continue;

            try {
              const data = JSON.parse(dataStr);

              // Handle Sources
              if (data.sources) {
                const currentMsgs = get().messages;
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

              // Handle Content
              if (data.content) {
                aiContent += data.content;
                const currentMsgs = get().messages;
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
            } catch (e) {
              console.error('Error parsing SSE data', e);
            }
          }
        }
      }

      get().fetchConversations();

    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        console.log('Generation stopped by user');
      } else {
        console.error('Failed to send message:', err);
        // Rollback only if it was a new message
        if (!isContinue) {
          const currentMsgs = get().messages;
          updateMessages(currentMsgs.filter(m => m.id !== tempUserId && m.id !== tempAiId));
        }
      }
    } finally {
      set({ sendingMessage: false, abortController: null });
    }
  }
}));

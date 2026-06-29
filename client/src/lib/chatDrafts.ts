const DRAFT_PREFIX = 'chatllm:draft';
const NEW_CONVERSATION_KEY = 'new';
const ANONYMOUS_USER_KEY = 'anonymous';

export interface ChatDraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

const normalizeKeyPart = (value?: string | null, fallback = NEW_CONVERSATION_KEY) => {
  const trimmed = value?.trim();
  return trimmed || fallback;
};

export const createChatDraftKey = (userId?: string | null, conversationId?: string | null) => {
  const userKey = normalizeKeyPart(userId, ANONYMOUS_USER_KEY);
  const conversationKey = normalizeKeyPart(conversationId, NEW_CONVERSATION_KEY);
  return `${DRAFT_PREFIX}:${userKey}:${conversationKey}`;
};

export const readChatDraft = (
  storage: ChatDraftStorage | undefined,
  userId?: string | null,
  conversationId?: string | null
) => {
  if (!storage) return '';

  try {
    return storage.getItem(createChatDraftKey(userId, conversationId)) || '';
  } catch {
    return '';
  }
};

export const writeChatDraft = (
  storage: ChatDraftStorage | undefined,
  userId: string | undefined | null,
  conversationId: string | undefined | null,
  value: string
) => {
  if (!storage) return;

  try {
    const key = createChatDraftKey(userId, conversationId);
    if (value) {
      storage.setItem(key, value);
    } else {
      storage.removeItem(key);
    }
  } catch {
    // Browser privacy settings can block storage; drafts are best-effort.
  }
};

export const clearChatDraft = (
  storage: ChatDraftStorage | undefined,
  userId?: string | null,
  conversationId?: string | null
) => {
  if (!storage) return;

  try {
    storage.removeItem(createChatDraftKey(userId, conversationId));
  } catch {
    // Browser privacy settings can block storage; drafts are best-effort.
  }
};

export const MAX_CHAT_MESSAGE_CONTENT_LENGTH = 20000;

type ValidChatMessageContent = {
  ok: true;
  content: string;
};

type InvalidChatMessageContent = {
  ok: false;
  statusCode: 400 | 413;
  error: string;
};

export const normalizeChatMessageContent = (
  value: unknown
): ValidChatMessageContent | InvalidChatMessageContent => {
  if (typeof value !== 'string') {
    return {
      ok: false,
      statusCode: 400,
      error: 'Content is required',
    };
  }

  const content = value.trim();
  if (!content) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Content is required',
    };
  }

  if (content.length > MAX_CHAT_MESSAGE_CONTENT_LENGTH) {
    return {
      ok: false,
      statusCode: 413,
      error: `Content exceeds ${MAX_CHAT_MESSAGE_CONTENT_LENGTH} characters`,
    };
  }

  return { ok: true, content };
};

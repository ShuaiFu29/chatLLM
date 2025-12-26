import { useRef, useState, useCallback, useEffect, useMemo, useDeferredValue } from 'react';
import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Message, Conversation } from '../stores/useChatStore';
import type { User } from '../stores/useAuthStore';
import ChatMessage from './ChatMessage';
import MessageSkeleton from './MessageSkeleton';

interface MessageListProps {
  messages: Message[];
  loadingMessages: boolean;
  sendingMessage: boolean;
  user: User | null;
  currentConversation?: Conversation;
  onCopy: (content: string, id: string) => void;
  onRegenerate: () => void;
  onDelete: (id: string) => void;
  copiedMessageId: string | null;
}

export default function MessageList({
  messages,
  loadingMessages,
  sendingMessage,
  user,
  currentConversation,
  onCopy,
  onRegenerate,
  onDelete,
  copiedMessageId
}: MessageListProps) {
  const { t } = useTranslation();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

  // Use deferred value for messages to prevent blocking UI during rapid streaming updates
  const deferredMessages = useDeferredValue(messages);

  // Merge messages for display to prevent duplicates
  const displayMessages = useMemo(() => {
    if (deferredMessages.length === 0) return [];

    const merged: Message[] = [];
    let currentMsg = deferredMessages[0];

    for (let i = 1; i < deferredMessages.length; i++) {
      const nextMsg = deferredMessages[i];
      if (currentMsg.role === 'assistant' && nextMsg.role === 'assistant') {
        // Merge content
        currentMsg = {
          ...currentMsg,
          content: currentMsg.content + nextMsg.content,
          // Merge sources if exist
          sources: [
            ...(currentMsg.sources || []),
            ...(nextMsg.sources || [])
          ]
        };
      } else {
        merged.push(currentMsg);
        currentMsg = nextMsg;
      }
    }
    merged.push(currentMsg);
    return merged;
  }, [deferredMessages]);

  // Handle scroll events to detect if user has scrolled up
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    // If user is near the bottom (within 100px), enable auto-scroll
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    setShouldAutoScroll(isNearBottom);
  }, []);

  // Auto-scroll to bottom only if shouldAutoScroll is true
  useEffect(() => {
    if (shouldAutoScroll && messagesEndRef.current) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }, [displayMessages.length, sendingMessage, displayMessages[displayMessages.length - 1]?.content?.length, shouldAutoScroll]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-2 md:p-4 space-y-8 scroll-smooth"
    >
      {loadingMessages ? (
        <div className="space-y-8 p-2">
          <MessageSkeleton />
          <MessageSkeleton />
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-text-muted p-8 h-full">
          <div className="w-16 h-16 bg-bg-surface rounded-2xl flex items-center justify-center mb-4">
            <Bot className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-xl font-semibold text-text-main mb-2">{t('chat.welcome')}</h2>
          <p>{t('chat.startChatting')}</p>
        </div>
      ) : (
        <>
          {displayMessages.map((msg, index) => (
            <ChatMessage
              key={msg.id}
              message={msg}
              isSending={sendingMessage}
              isLast={index === displayMessages.length - 1}
              userAvatar={user?.avatar_url}
              userName={user?.display_name || user?.username}
              onCopy={onCopy}
              onRegenerate={onRegenerate}
              onDelete={onDelete}
              copiedMessageId={copiedMessageId}
              enableRag={currentConversation?.enable_rag}
            />
          ))}
          <div ref={messagesEndRef} />
        </>
      )}
    </div>
  );
}

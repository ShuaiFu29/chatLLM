import { memo, lazy, Suspense } from 'react';
import { Bot, RefreshCw, Trash2, Check, Copy, Search, BookOpen, FileText, Loader2 } from 'lucide-react';
import type { Message } from '../stores/useChatStore';
import { useTranslation } from 'react-i18next';

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

interface ChatMessageProps {
  message: Message;
  isSending: boolean;
  isLast: boolean;
  userAvatar?: string;
  userName?: string;
  onCopy: (content: string, id: string) => void;
  onRegenerate: () => void;
  onDelete: (id: string) => void;
  copiedMessageId: string | null;
  enableRag?: boolean;
}

const ChatMessage = memo(({
  message: msg,
  isSending,
  isLast,
  userAvatar,
  userName,
  onCopy,
  onRegenerate,
  onDelete,
  copiedMessageId,
  enableRag
}: ChatMessageProps) => {
  const { t } = useTranslation();

  const formatFilename = (filename: string) => {
    return filename.replace(/\.[^/.]+$/, "").trim();
  };

  return (
    <div className={`flex gap-2 md:gap-4 group ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      {msg.role === 'assistant' && (
        <div className="flex w-8 h-8 rounded-full bg-primary/20 border border-primary/30 items-center justify-center shrink-0 shadow-sm">
          <Bot className="w-5 h-5 text-primary-light" />
        </div>
      )}

      <div className={`max-w-[85%] relative ${msg.role === 'user' ? 'order-1' : 'order-2'}`}>
        <div className={`rounded-xl md:rounded-2xl px-3 py-2.5 md:px-5 md:py-4 shadow-sm ${msg.role === 'user'
          ? 'bg-primary/10 text-text-main border border-primary/20'
          : 'bg-bg-sidebar/50 text-text-main border border-border/50'
          }`}>
          {msg.role === 'user' ? (
            <p className="whitespace-pre-wrap leading-relaxed text-sm md:text-base">{msg.content}</p>
          ) : (
            <>
              {/* RAG Status / Thinking Indicator */}
              {isSending && isLast && !msg.content && enableRag !== false && (
                <div className="flex items-center gap-2 text-text-muted mb-2 animate-pulse">
                  <Search className="w-4 h-4" />
                  <span className="text-sm">Searching knowledge base...</span>
                </div>
              )}

              {/* Content */}
              {(msg.content || !isSending) && (
                <div className="text-sm md:text-base min-h-[24px]">
                  <Suspense fallback={
                    <div className="flex items-center gap-2 text-text-muted">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-xs">Loading content...</span>
                    </div>
                  }>
                    <MarkdownRenderer content={
                      msg.role === 'assistant' && isSending && isLast
                        ? msg.content + ' ▍'
                        : msg.content
                    } />
                  </Suspense>
                </div>
              )}

              {/* Enhanced Sources Display */}
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-4 pt-3 border-t border-border/50">
                  <div className="flex items-center gap-2 mb-2">
                    <BookOpen className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                      {t('chat.sources') || 'Sources & References'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {Array.from(new Set(msg.sources.map(s => s.filename))).map((filename, idx) => (
                      <div key={idx} className="flex items-center gap-2 bg-bg-surface/50 hover:bg-bg-surface p-2 rounded-lg border border-border/50 transition-all cursor-default group/source">
                        <div className="p-1.5 rounded-md bg-primary/10 text-primary group-hover/source:bg-primary group-hover/source:text-white transition-colors">
                          <FileText className="w-3.5 h-3.5" />
                        </div>
                        <div className="flex flex-col overflow-hidden">
                          <span className="text-xs font-medium text-text-main truncate">{formatFilename(filename)}</span>
                          <span className="text-[10px] text-text-muted truncate">Document Match</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Message Actions */}
        <div className={`absolute -bottom-5 md:-bottom-6 ${msg.role === 'user' ? 'right-0' : 'left-0'} flex items-center gap-1 opacity-100 md:opacity-0 group-hover:opacity-100 transition-opacity`}>
          <button
            onClick={() => onCopy(msg.content, msg.id)}
            className="p-1 text-text-muted hover:text-text-main hover:bg-bg-surface rounded transition-colors"
            title={t('common.copy') || 'Copy'}
            aria-label={t('common.copy') || 'Copy'}
          >
            {copiedMessageId === msg.id ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
          </button>

          {/* Regenerate only for the latest assistant message */}
          {isLast && !isSending && msg.role === 'assistant' && (
            <button
              onClick={onRegenerate}
              className="p-1 text-text-muted hover:text-primary hover:bg-bg-surface rounded transition-colors"
              title={t('chat.regenerate') || 'Regenerate'}
              aria-label={t('chat.regenerate') || 'Regenerate'}
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}

          <button
            onClick={() => onDelete(msg.id)}
            className="p-1 text-text-muted hover:text-red-500 hover:bg-bg-surface rounded transition-colors"
            title={t('common.delete') || 'Delete'}
            aria-label={t('common.delete') || 'Delete'}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {msg.role === 'user' && (
        <img
          src={userAvatar ? `${userAvatar}&s=64` : undefined}
          alt="User"
          className="w-8 h-8 rounded-full bg-bg-surface shrink-0 order-3 object-cover"
          loading="lazy"
          onError={(e) => (e.currentTarget.src = `https://ui-avatars.com/api/?name=${userName || 'User'}`)}
        />
      )}
    </div>
  );
});

export default ChatMessage;
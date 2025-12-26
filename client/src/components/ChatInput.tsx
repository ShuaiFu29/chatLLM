import React, { useRef, useEffect, memo } from 'react';
import { Send, Paperclip, Loader2, Square, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ChatInputProps {
  input: string;
  setInput: (value: string) => void;
  onSendMessage: (e: React.FormEvent | React.KeyboardEvent) => void;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onStop: () => void;
  onContinue: () => void;
  isSending: boolean;
  isUploading: boolean;
  isStopped: boolean;
  canContinue: boolean;
}

const ChatInput = memo(({
  input,
  setInput,
  onSendMessage,
  onFileUpload,
  onStop,
  onContinue,
  isSending,
  isUploading,
  isStopped,
  canContinue
}: ChatInputProps) => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-resize textarea
  const adjustHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };

  useEffect(() => {
    adjustHeight();
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSendMessage(e);
    }
  };

  return (
    <div className="p-2 md:p-4 border-t border-border bg-bg-sidebar/50 backdrop-blur">
      <div className="max-w-4xl mx-auto">
        <form onSubmit={onSendMessage} className="relative flex items-end gap-2">
          <input
            type="file"
            ref={fileInputRef}
            onChange={onFileUpload}
            className="hidden"
            accept=".md"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="p-3 mb-0.5 text-text-muted hover:text-text-main hover:bg-bg-surface rounded-xl transition-colors disabled:opacity-50 h-[46px]"
            title={t('chat.uploadContext')}
            aria-label={t('chat.uploadContext')}
          >
            {isUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-5 h-5" />}
          </button>

          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('chat.typeMessage')}
              className="w-full bg-bg-base text-text-main rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary border border-border placeholder-text-muted resize-none min-h-[46px] max-h-[200px]"
              disabled={isSending}
              rows={1}
              aria-label={t('chat.typeMessage')}
            />
          </div>

          {isSending ? (
            <button
              type="button"
              onClick={onStop}
              className="p-3 mb-0.5 text-primary-light hover:text-white hover:bg-red-500 rounded-xl transition-all border border-transparent hover:border-red-500 h-[46px]"
              title={t('chat.stopGenerating')}
              aria-label={t('chat.stopGenerating')}
            >
              <Square className="w-5 h-5 fill-current" />
            </button>
          ) : isStopped && canContinue ? (
            <button
              type="button"
              onClick={onContinue}
              className="p-3 mb-0.5 text-primary-light hover:text-white hover:bg-primary rounded-xl transition-all border border-transparent hover:border-primary h-[46px]"
              title={t('chat.continueGenerating')}
              aria-label={t('chat.continueGenerating')}
            >
              <Play className="w-5 h-5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="p-3 mb-0.5 text-primary-light hover:text-white hover:bg-primary rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed border border-transparent hover:border-primary h-[46px]"
              aria-label={t('chat.sendMessage') || 'Send Message'}
            >
              <Send className="w-5 h-5" />
            </button>
          )}
        </form>
      </div>
    </div>
  );
});

export default ChatInput;
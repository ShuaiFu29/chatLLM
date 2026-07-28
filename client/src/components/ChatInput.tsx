import React, { useRef, useEffect, memo } from 'react';
import { Send, Paperclip, Loader2, Square, Play, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DOCUMENT_UPLOAD_ACCEPT } from '../lib/uploadManager';

interface ChatInputProps {
  input: string;
  setInput: (value: string) => void;
  onSendMessage: (e: React.FormEvent | React.KeyboardEvent) => void;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClearDraft: () => void;
  onStop: () => void;
  onContinue: () => void;
  isSending: boolean;
  isUploading: boolean;
  isStopped: boolean;
  canContinue: boolean;
  draftStatusLabel?: string;
}

const ChatInput = memo(({
  input,
  setInput,
  onSendMessage,
  onFileUpload,
  onClearDraft,
  onStop,
  onContinue,
  isSending,
  isUploading,
  isStopped,
  canContinue,
  draftStatusLabel
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
    <div className="shrink-0 border-t border-border/70 bg-bg-base px-3 pb-4 pt-2 md:px-6 md:pb-5">
      <div className="mx-auto max-w-3xl">
        {draftStatusLabel && (
          <div className="mb-1 flex justify-end px-2 text-[11px] text-text-muted">
            {draftStatusLabel}
          </div>
        )}
        <form
          onSubmit={onSendMessage}
          className="flex items-end gap-1.5 rounded-2xl border border-border bg-bg-sidebar p-2 shadow-sm transition-shadow focus-within:border-primary focus-within:shadow-md md:gap-2"
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={onFileUpload}
            className="hidden"
            accept={DOCUMENT_UPLOAD_ACCEPT}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main disabled:opacity-50 md:h-11 md:w-11"
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
              className="block min-h-10 max-h-[180px] w-full resize-none rounded-xl bg-bg-base px-3 py-2.5 text-sm leading-5 text-text-main outline-none placeholder:text-text-muted md:min-h-11 md:px-4 md:py-3 md:text-base"
              disabled={isSending}
              rows={1}
              aria-label={t('chat.typeMessage')}
            />
          </div>

          <button
            type="button"
            onClick={onClearDraft}
            disabled={!input.trim() || isSending}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main disabled:cursor-not-allowed disabled:opacity-40 md:h-11 md:w-11"
            title={t('chat.clearDraft')}
            aria-label={t('chat.clearDraft')}
          >
            <X className="w-5 h-5" />
          </button>

          {isSending ? (
            <button
              type="button"
              onClick={onStop}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-transparent text-primary-light transition-all hover:border-red-500 hover:bg-red-500 hover:text-white md:h-11 md:w-11"
              title={t('chat.stopGenerating')}
              aria-label={t('chat.stopGenerating')}
            >
              <Square className="w-5 h-5 fill-current" />
            </button>
          ) : isStopped && canContinue ? (
            <button
              type="button"
              onClick={onContinue}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-transparent text-primary-light transition-all hover:border-primary hover:bg-primary hover:text-white md:h-11 md:w-11"
              title={t('chat.continueGenerating')}
              aria-label={t('chat.continueGenerating')}
            >
              <Play className="w-5 h-5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-transparent bg-primary text-white transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-bg-surface disabled:text-text-muted md:h-11 md:w-11"
              aria-label={t('chat.sendMessage')}
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

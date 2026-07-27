import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { ChatStreamError, useChatStore } from '../stores/useChatStore';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { isSupportedMarkdownDocument, uploadFile, type UploadProgress } from '../lib/uploadManager';
import { toSafeError } from '../lib/safeError';
import ChatSettingsDialog from '../components/ChatSettingsDialog';
import ChatHeader from '../components/ChatHeader';
import MessageList from '../components/MessageList';
import ChatInput from '../components/ChatInput';
import PersonaSuggestionsPanel from '../components/PersonaSuggestionsPanel';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';
import {
  buildConversationMarkdown,
  createConversationExportFilename,
  downloadTextFile,
} from '../lib/exportConversation';
import {
  clearChatDraft,
  createChatDraftKey,
  readChatDraft,
  writeChatDraft,
} from '../lib/chatDrafts';
import { X } from 'lucide-react';
import type { ConversationComparison } from '../stores/useChatStore';

export default function ChatPage() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const { currentProjectSpaceId, projectSpaces } = useProjectSpaceStore();
  const {
    currentConversationId,
    conversations,
    messages,
    createConversation,
    branchConversation,
    compareConversations,
    toggleConversationFavorite,
    sendMessage,
    deleteMessage,
    regenerateMessage,
    stopGeneration,
    continueGeneration,
    loadOlderMessages,
    messagePagination,
    loadingOlderMessages,
    loadingMessages,
    sendingMessage,
    isStopped
  } = useChatStore();

  const [input, setInput] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [compareTargetId, setCompareTargetId] = useState('');
  const [comparison, setComparison] = useState<ConversationComparison | null>(null);
  const [isComparing, setIsComparing] = useState(false);

  const currentConversation = conversations.find(c => c.id === currentConversationId);
  const currentMessagePageInfo = currentConversationId ? messagePagination[currentConversationId] : undefined;
  const activeProjectSpaceId = currentConversation?.project_space_id || currentProjectSpaceId;
  const currentProjectSpace = projectSpaces.find(space => space.id === activeProjectSpaceId);
  const currentDraftKey = useMemo(
    () => createChatDraftKey(user?.id, currentConversationId),
    [currentConversationId, user?.id]
  );
  const relatedConversations = useMemo(() => {
    if (!currentConversation) return [];

    const lineageRootId = currentConversation.parent_conversation_id || currentConversation.id;

    return conversations.filter((conversation) => {
      if (conversation.id === currentConversation.id || conversation.archived_at) return false;
      return conversation.id === currentConversation.parent_conversation_id
        || conversation.parent_conversation_id === currentConversation.id
        || conversation.parent_conversation_id === lineageRootId;
    });
  }, [conversations, currentConversation]);

  useEffect(() => {
    const draftStorage = typeof window === 'undefined' ? undefined : window.localStorage;
    setInput(readChatDraft(draftStorage, user?.id, currentConversationId));
  }, [currentConversationId, currentDraftKey, user?.id]);

  useEffect(() => {
    if (relatedConversations.length === 0) {
      setCompareTargetId('');
      setComparison(null);
      return;
    }

    if (!relatedConversations.some((conversation) => conversation.id === compareTargetId)) {
      setCompareTargetId(relatedConversations[0].id);
      setComparison(null);
    }
  }, [compareTargetId, relatedConversations]);

  const handleInputChange = useCallback((value: string) => {
    const draftStorage = typeof window === 'undefined' ? undefined : window.localStorage;
    setInput(value);
    writeChatDraft(draftStorage, user?.id, currentConversationId, value);
  }, [currentConversationId, user?.id]);

  const handleClearDraft = useCallback(() => {
    const draftStorage = typeof window === 'undefined' ? undefined : window.localStorage;
    clearChatDraft(draftStorage, user?.id, currentConversationId);
    setInput('');
  }, [currentConversationId, user?.id]);

  const showGenerationError = useCallback((error: unknown) => {
    if (error instanceof ChatStreamError && error.code === 'rag_retrieval_unavailable') {
      toast.error(t('chat.ragRetrievalFailed'));
      return;
    }

    const retryable = !(error instanceof ChatStreamError) || error.retryable;
    toast.error(t(retryable ? 'chat.generationFailedRetryable' : 'chat.generationFailed'));
  }, [t]);

  const handlePersonaSuggestionPick = useCallback((question: string) => {
    handleInputChange(question);
    toast.success(t('persona.suggestionLoaded'));
  }, [handleInputChange, t]);

  const handleEditMessageAsDraft = useCallback((content: string) => {
    handleInputChange(content);
    toast.success(t('chat.messageLoadedToDraft'));
  }, [handleInputChange, t]);

  const handleSendMessage = useCallback(async (e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault();
    if (!input.trim() || sendingMessage) return;

    // If no conversation selected, create one first
    if (!currentConversationId) {
      await createConversation(input.slice(0, 30), { project_space_id: currentProjectSpaceId }); // Use first 30 chars as title
    }

    const content = input;
    const draftStorage = typeof window === 'undefined' ? undefined : window.localStorage;
    clearChatDraft(draftStorage, user?.id, currentConversationId);
    setInput('');
    try {
      await sendMessage(content);
    } catch (error) {
      setInput(content);
      writeChatDraft(draftStorage, user?.id, currentConversationId, content);
      showGenerationError(error);
    }
  }, [
    input,
    sendingMessage,
    currentConversationId,
    createConversation,
    currentProjectSpaceId,
    sendMessage,
    showGenerationError,
    user?.id,
  ]);

  const handleRegenerateMessage = useCallback(async () => {
    try {
      await regenerateMessage();
    } catch (error) {
      showGenerationError(error);
    }
  }, [regenerateMessage, showGenerationError]);

  const handleContinueGeneration = useCallback(async () => {
    try {
      await continueGeneration();
    } catch (error) {
      showGenerationError(error);
    }
  }, [continueGeneration, showGenerationError]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (!isSupportedMarkdownDocument(file)) {
      toast.error(t('chat.unsupportedFileType'));
      return;
    }

    setIsUploading(true);
    const toastId = toast.loading(t('common.uploading'));

    try {
      await uploadFile(file, (progress: UploadProgress) => {
        if (progress.status === 'hashing') {
          toast.message(t('chat.uploadHashing', { progress: progress.progress }), { id: toastId });
        } else if (progress.status === 'uploading') {
          toast.message(t('chat.uploadUploading', { progress: progress.progress }), { id: toastId });
        } else if (progress.status === 'merging') {
          toast.message(t('chat.uploadMerging'), { id: toastId });
        } else if (progress.status === 'processing') {
          toast.message(t('chat.uploadProcessing'), { id: toastId });
        }
      }, { projectSpaceId: currentProjectSpaceId });

      toast.success(`${file.name} ${t('chat.uploadSuccess')}`, { id: toastId });
    } catch (error) {
      console.error('Upload failed:', toSafeError(error));
      toast.error(t('chat.uploadFail'), { id: toastId });
    } finally {
      setIsUploading(false);
    }
  }, [currentProjectSpaceId, t]);

  const handleCopyMessage = useCallback((content: string, id: string) => {
    navigator.clipboard.writeText(content);
    setCopiedMessageId(id);
    toast.success(t('common.copied'));
    setTimeout(() => setCopiedMessageId(null), 2000);
  }, [t]);

  const handleExportConversation = useCallback(() => {
    if (!currentConversation || messages.length === 0) {
      toast.error(t('chat.exportNoMessages'));
      return;
    }

    try {
      const exportedAt = new Date();
      const markdown = buildConversationMarkdown({
        conversation: currentConversation,
        messages,
        workspaceName: currentProjectSpace?.name,
        exportedAt,
      });
      const filename = createConversationExportFilename(currentConversation.title, exportedAt);
      downloadTextFile(filename, markdown);
      toast.success(t('chat.exportSuccess'));
    } catch (error) {
      console.error('Failed to export conversation:', toSafeError(error));
      toast.error(t('chat.exportFail'));
    }
  }, [currentConversation, currentProjectSpace?.name, messages, t]);

  const handleBranchConversation = useCallback(async (messageId: string) => {
    if (!currentConversationId) return;

    const branchId = await branchConversation(currentConversationId, messageId);
    if (branchId) {
      toast.success(t('chat.branchCreated'));
    } else {
      toast.error(t('chat.branchFailed'));
    }
  }, [branchConversation, currentConversationId, t]);

  const handleCompareVersions = useCallback(async () => {
    if (!currentConversationId || !compareTargetId) return;

    setIsComparing(true);
    const result = await compareConversations(currentConversationId, compareTargetId);
    setIsComparing(false);

    if (result) {
      setComparison(result);
    } else {
      toast.error(t('chat.compareFailed'));
    }
  }, [compareConversations, compareTargetId, currentConversationId, t]);

  const handleToggleFavorite = useCallback(() => {
    if (currentConversationId) {
      void toggleConversationFavorite(currentConversationId);
    }
  }, [currentConversationId, toggleConversationFavorite]);

  const canContinue = messages.length > 0 && messages[messages.length - 1].role === 'assistant';

  return (
    <div className="flex flex-col h-full relative">
      <ChatHeader
        conversation={currentConversation}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onExport={handleExportConversation}
        canExport={!!currentConversation && messages.length > 0}
        onToggleFavorite={handleToggleFavorite}
        relatedConversations={relatedConversations}
        compareTargetId={compareTargetId}
        onCompareTargetChange={setCompareTargetId}
        onCompare={handleCompareVersions}
      />

      {comparison && (
        <div className="absolute right-4 top-16 z-20 w-[calc(100%-2rem)] max-w-3xl overflow-hidden rounded-lg border border-border bg-bg-sidebar shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-text-main">{t('chat.compareVersions')}</h3>
              <p className="text-xs text-text-muted">{isComparing ? t('common.loading') : t('chat.compareHint')}</p>
            </div>
            <button
              onClick={() => setComparison(null)}
              className="rounded p-1 text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main"
              aria-label={t('common.close')}
              title={t('common.close')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto p-4 md:grid-cols-2">
            {comparison.conversations.map((conversation) => {
              const comparisonMessages = comparison.messagesByConversation[conversation.id] || [];
              const lastMessage = comparisonMessages[comparisonMessages.length - 1];

              return (
                <div key={conversation.id} className="rounded-lg border border-border bg-bg-base p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h4 className="truncate text-sm font-medium text-text-main">
                      {conversation.title === 'New Chat' ? t('sidebar.newChat') : conversation.title}
                    </h4>
                    <span className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted">
                      {t('chat.messagesCount', { count: comparisonMessages.length })}
                    </span>
                  </div>
                  <p className="text-xs leading-5 text-text-muted">
                    {lastMessage?.content || t('chat.noBranchPreview')}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ChatSettingsDialog isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      <MessageList
        messages={messages}
        loadingMessages={loadingMessages}
        sendingMessage={sendingMessage}
        user={user}
        currentConversation={currentConversation}
        hasMoreMessages={!!currentMessagePageInfo?.hasMore}
        loadingOlderMessages={loadingOlderMessages}
        onLoadOlderMessages={() => loadOlderMessages(currentConversationId || undefined)}
        onCopy={handleCopyMessage}
        onRegenerate={handleRegenerateMessage}
        onDelete={deleteMessage}
        onBranch={handleBranchConversation}
        onEditAsDraft={handleEditMessageAsDraft}
        copiedMessageId={copiedMessageId}
      />

      <PersonaSuggestionsPanel onPickSuggestion={handlePersonaSuggestionPick} />

      <ChatInput
        input={input}
        setInput={handleInputChange}
        onSendMessage={handleSendMessage}
        onFileUpload={handleFileUpload}
        onClearDraft={handleClearDraft}
        onStop={stopGeneration}
        onContinue={handleContinueGeneration}
        isSending={sendingMessage}
        isUploading={isUploading}
        isStopped={isStopped}
        canContinue={canContinue}
        draftStatusLabel={input.trim() ? t('chat.draftSaved') : undefined}
      />
    </div>
  );
}

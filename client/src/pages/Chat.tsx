import { useState, useCallback } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { useChatStore } from '../stores/useChatStore';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { uploadFile, type UploadProgress } from '../lib/uploadManager';
import ChatSettingsDialog from '../components/ChatSettingsDialog';
import ChatHeader from '../components/ChatHeader';
import MessageList from '../components/MessageList';
import ChatInput from '../components/ChatInput';

export default function ChatPage() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const {
    currentConversationId,
    conversations,
    messages,
    createConversation,
    sendMessage,
    deleteMessage,
    regenerateMessage,
    stopGeneration,
    continueGeneration,
    loadingMessages,
    sendingMessage,
    isStopped
  } = useChatStore();

  const [input, setInput] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const currentConversation = conversations.find(c => c.id === currentConversationId);

  const handleSendMessage = useCallback(async (e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault();
    if (!input.trim() || sendingMessage) return;

    // If no conversation selected, create one first
    if (!currentConversationId) {
      await createConversation(input.slice(0, 30)); // Use first 30 chars as title
    }

    const content = input;
    setInput('');
    await sendMessage(content);
  }, [input, sendingMessage, currentConversationId, createConversation, sendMessage]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const toastId = toast.loading(t('common.uploading') || 'Uploading...');

    try {
      await uploadFile(file, (progress: UploadProgress) => {
        if (progress.status === 'hashing') {
          toast.message(`Hashing: ${progress.progress}%`, { id: toastId });
        } else if (progress.status === 'uploading') {
          toast.message(`Uploading: ${progress.progress}%`, { id: toastId });
        } else if (progress.status === 'merging') {
          toast.message('Merging file...', { id: toastId });
        } else if (progress.status === 'processing') {
          toast.message('Processing file content...', { id: toastId });
        }
      });

      console.log('File uploaded successfully');
      toast.success(`${file.name} ${t('chat.uploadSuccess')}`, { id: toastId });
    } catch (error) {
      console.error('Upload failed:', error);
      toast.error(t('chat.uploadFail'), { id: toastId });
    } finally {
      setIsUploading(false);
    }
  }, [t]);

  const handleCopyMessage = useCallback((content: string, id: string) => {
    navigator.clipboard.writeText(content);
    setCopiedMessageId(id);
    toast.success(t('common.copied'));
    setTimeout(() => setCopiedMessageId(null), 2000);
  }, [t]);

  const canContinue = messages.length > 0 && messages[messages.length - 1].role === 'assistant';

  return (
    <div className="flex flex-col h-full relative">
      <ChatHeader
        conversation={currentConversation}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <ChatSettingsDialog isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      <MessageList
        messages={messages}
        loadingMessages={loadingMessages}
        sendingMessage={sendingMessage}
        user={user}
        currentConversation={currentConversation}
        onCopy={handleCopyMessage}
        onRegenerate={regenerateMessage}
        onDelete={deleteMessage}
        copiedMessageId={copiedMessageId}
      />

      <ChatInput
        input={input}
        setInput={setInput}
        onSendMessage={handleSendMessage}
        onFileUpload={handleFileUpload}
        onStop={stopGeneration}
        onContinue={continueGeneration}
        isSending={sendingMessage}
        isUploading={isUploading}
        isStopped={isStopped}
        canContinue={canContinue}
      />
    </div>
  );
}

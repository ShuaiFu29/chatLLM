import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertCircle, BarChart3, Bot, Clock, Database, FileText, MessageSquare, RefreshCw, UserRound } from 'lucide-react';
import api from '../lib/api';
import Modal from '../components/Modal';
import Skeleton from '../components/Skeleton';

interface UsageSummary {
  totalWorkspaces: number;
  totalConversations: number;
  totalMessages: number;
  totalUserMessages: number;
  totalAssistantMessages: number;
  totalDocuments: number;
  completedDocuments: number;
  failedDocuments: number;
  totalCitations: number;
  estimatedTokens: number;
  modelUsage: UsageModelUsage[];
  firstMessageAt?: string | null;
  lastMessageAt?: string | null;
}

interface UsageModelUsage {
  model: string;
  conversationCount: number;
  messageCount: number;
  estimatedTokens: number;
}

interface UsageConversation {
  id: string;
  title: string;
  project_space_id?: string | null;
  project_space_name?: string | null;
  model?: string | null;
  enable_rag: boolean;
  created_at: string;
  updated_at: string;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  source_count: number;
  first_message_at?: string | null;
  last_message_at?: string | null;
}

interface UsageConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content_preview: string;
  content_length: number;
  source_count: number;
  source_filenames: string[];
  created_at: string;
}

interface UsageOverviewResponse {
  summary: UsageSummary;
  conversations: UsageConversation[];
}

interface UsageConversationResponse {
  conversation: UsageConversation;
  messages: UsageConversationMessage[];
}

interface UsageFileQueueSummary {
  total: number;
  uploading: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  retryableFailed: number;
  nextRetryAt?: string | null;
}

interface UsageFileQueueItem {
  id: string;
  filename: string;
  status: 'uploading' | 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  attempts: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  last_attempt_at?: string | null;
  error_message?: string | null;
  updated_at: string;
}

interface UsageFileQueueResponse {
  summary: UsageFileQueueSummary;
  files: UsageFileQueueItem[];
}

const emptySummary: UsageSummary = {
  totalWorkspaces: 0,
  totalConversations: 0,
  totalMessages: 0,
  totalUserMessages: 0,
  totalAssistantMessages: 0,
  totalDocuments: 0,
  completedDocuments: 0,
  failedDocuments: 0,
  totalCitations: 0,
  estimatedTokens: 0,
  modelUsage: [],
  firstMessageAt: null,
  lastMessageAt: null,
};

export default function UsagePage() {
  const { t, i18n } = useTranslation();
  const [overview, setOverview] = useState<UsageOverviewResponse | null>(null);
  const [fileQueue, setFileQueue] = useState<UsageFileQueueResponse | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationTrace, setConversationTrace] = useState<UsageConversationResponse | null>(null);
  const [selectedFileJob, setSelectedFileJob] = useState<UsageFileQueueItem | null>(null);
  const [isTraceModalOpen, setIsTraceModalOpen] = useState(false);
  const [isLoadingOverview, setIsLoadingOverview] = useState(true);
  const [isLoadingFileQueue, setIsLoadingFileQueue] = useState(true);
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    [i18n.language]
  );

  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language]
  );

  const formatDateTime = useCallback((value?: string | null) => {
    if (!value) return t('usage.never');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('usage.never');
    return dateFormatter.format(date);
  }, [dateFormatter, t]);

  const formatNumber = useCallback((value: number) => numberFormatter.format(value || 0), [numberFormatter]);

  const formatFilename = useCallback((filename: string) => {
    return filename.replace(/\.(?:md|markdown)$/i, '').trim();
  }, []);

  const fetchOverview = useCallback(async () => {
    setIsLoadingOverview(true);
    setError(null);

    try {
      const { data } = await api.get<UsageOverviewResponse>('/usage');
      setOverview(data);
    } catch (fetchError) {
      console.error('Failed to fetch usage overview:', fetchError);
      setError(t('usage.loadFailed'));
    } finally {
      setIsLoadingOverview(false);
    }
  }, [t]);

  const fetchFileQueue = useCallback(async () => {
    setIsLoadingFileQueue(true);
    setQueueError(null);

    try {
      const { data } = await api.get<UsageFileQueueResponse>('/usage/file-queue');
      setFileQueue(data);
    } catch (fetchError) {
      console.error('Failed to fetch usage file queue:', fetchError);
      setQueueError(t('usage.queueLoadFailed'));
    } finally {
      setIsLoadingFileQueue(false);
    }
  }, [t]);

  const fetchConversationTrace = useCallback(async (conversationId: string) => {
    setSelectedConversationId(conversationId);
    setConversationTrace(null);
    setIsTraceModalOpen(true);
    setIsLoadingTrace(true);
    setTraceError(null);

    try {
      const { data } = await api.get<UsageConversationResponse>(`/usage/conversations/${conversationId}`);
      setConversationTrace(data);
    } catch (fetchError) {
      console.error('Failed to fetch usage conversation trace:', fetchError);
      setTraceError(t('usage.traceLoadFailed'));
    } finally {
      setIsLoadingTrace(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchOverview();
    void fetchFileQueue();
  }, [fetchFileQueue, fetchOverview]);

  const summary = overview?.summary || emptySummary;
  const conversations = overview?.conversations || [];
  const activeConversation = conversationTrace?.conversation
    || conversations.find((conversation) => conversation.id === selectedConversationId)
    || null;

  const statCards = [
    {
      label: t('usage.totalConversations'),
      value: formatNumber(summary.totalConversations),
      icon: MessageSquare,
    },
    {
      label: t('usage.totalMessages'),
      value: formatNumber(summary.totalMessages),
      icon: Activity,
    },
    {
      label: t('usage.workspaces'),
      value: formatNumber(summary.totalWorkspaces),
      icon: Database,
    },
    {
      label: t('usage.documents'),
      value: formatNumber(summary.totalDocuments),
      icon: FileText,
    },
    {
      label: t('usage.estimatedTokens'),
      value: formatNumber(summary.estimatedTokens),
      icon: Bot,
    },
  ];

  const handleRefresh = useCallback(() => {
    void fetchOverview();
    void fetchFileQueue();
  }, [fetchFileQueue, fetchOverview]);

  return (
    <div className="flex h-full flex-col bg-bg-base text-text-main transition-colors duration-300">
      <div className="hidden items-center justify-between gap-4 border-b border-border bg-bg-sidebar p-4 md:flex">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">{t('usage.title')}</h1>
            <p className="text-sm text-text-muted">{t('usage.subtitle')}</p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isLoadingOverview || isLoadingFileQueue}
          className="flex items-center gap-2 rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text-muted transition-colors hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isLoadingOverview || isLoadingFileQueue ? 'animate-spin' : ''}`} />
          {t('usage.refresh')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-5">
          <div className="md:hidden">
            <h1 className="text-xl font-semibold">{t('usage.title')}</h1>
            <p className="mt-1 text-sm text-text-muted">{t('usage.subtitle')}</p>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {queueError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {queueError}
            </div>
          )}

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-text-muted">{t('usage.overview')}</h2>
              <p className="text-xs text-text-muted">{t('usage.lastActivity')}: {formatDateTime(summary.lastMessageAt)}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              {statCards.map((card) => (
                <div key={card.label} className="rounded-lg border border-border bg-bg-sidebar p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs font-medium text-text-muted">{card.label}</span>
                    <card.icon className="h-4 w-4 text-primary" />
                  </div>
                  {isLoadingOverview ? (
                    <Skeleton className="h-8 w-20 rounded" />
                  ) : (
                    <p className="text-2xl font-semibold">{card.value}</p>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-border bg-bg-sidebar p-4">
                <p className="text-xs font-medium text-text-muted">{t('usage.messageMix')}</p>
                <p className="mt-2 text-sm">
                  <span className="text-text-main">{formatNumber(summary.totalUserMessages)}</span>
                  <span className="mx-2 text-text-muted">/</span>
                  <span className="text-text-main">{formatNumber(summary.totalAssistantMessages)}</span>
                </p>
                <p className="mt-1 text-xs text-text-muted">{t('usage.userVsAssistant')}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-sidebar p-4">
                <p className="text-xs font-medium text-text-muted">{t('usage.completedDocuments')}</p>
                <p className="mt-2 text-sm">
                  <span className="text-text-main">{formatNumber(summary.completedDocuments)}</span>
                  {summary.failedDocuments > 0 && (
                    <span className="ml-2 text-red-300">{t('usage.failedDocuments', { count: summary.failedDocuments })}</span>
                  )}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-bg-sidebar p-4">
                <p className="text-xs font-medium text-text-muted">{t('usage.citations')}</p>
                <p className="mt-2 text-sm text-text-main">{formatNumber(summary.totalCitations)}</p>
                <p className="mt-1 text-xs text-text-muted">{t('usage.citationsHint')}</p>
              </div>
            </div>
            <div className="mt-3 rounded-lg border border-border bg-bg-sidebar p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">{t('usage.modelUsage')}</h3>
                  <p className="text-xs text-text-muted">{t('usage.modelUsageHint')}</p>
                </div>
              </div>
              {isLoadingOverview ? (
                <Skeleton className="h-16 w-full rounded-lg" />
              ) : summary.modelUsage.length === 0 ? (
                <p className="text-sm text-text-muted">{t('usage.noModelUsage')}</p>
              ) : (
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {summary.modelUsage.map((item) => (
                    <div key={item.model} className="rounded-lg border border-border bg-bg-base p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-text-main">{item.model}</p>
                        <span className="rounded border border-border px-2 py-0.5 text-[11px] text-text-muted">
                          {formatNumber(item.conversationCount)}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <p className="text-text-muted">{t('usage.messages')}</p>
                          <p className="mt-1 text-text-main">{formatNumber(item.messageCount)}</p>
                        </div>
                        <div>
                          <p className="text-text-muted">{t('usage.estimatedTokens')}</p>
                          <p className="mt-1 text-text-main">{formatNumber(item.estimatedTokens)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-bg-sidebar p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">{t('usage.documentProcessing')}</h2>
                <p className="text-xs text-text-muted">{t('usage.documentProcessingHint')}</p>
              </div>
              <FileText className="h-5 w-5 text-primary" />
            </div>

            {isLoadingFileQueue ? (
              <Skeleton className="h-32 w-full rounded-lg" />
            ) : (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)]">
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-lg border border-border bg-bg-base p-3">
                    <p className="text-lg font-semibold text-text-main">{formatNumber(fileQueue?.summary.pending || 0)}</p>
                    <p className="text-text-muted">{t('usage.pendingDocuments')}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-bg-base p-3">
                    <p className="text-lg font-semibold text-text-main">{formatNumber(fileQueue?.summary.processing || 0)}</p>
                    <p className="text-text-muted">{t('usage.processingDocuments')}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-bg-base p-3">
                    <p className="text-lg font-semibold text-text-main">{formatNumber(fileQueue?.summary.retryableFailed || 0)}</p>
                    <p className="text-text-muted">{t('usage.retryableDocuments')}</p>
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{t('usage.recentDocumentJobs')}</h3>
                    <span className="flex items-center gap-1 text-xs text-text-muted">
                      <Clock className="h-3.5 w-3.5" />
                      {t('usage.nextRetry')}: {formatDateTime(fileQueue?.summary.nextRetryAt)}
                    </span>
                  </div>
                  {fileQueue?.files.length === 0 ? (
                    <p className="rounded-lg border border-border bg-bg-base p-4 text-sm text-text-muted">{t('knowledge.noDocuments')}</p>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {fileQueue?.files.map((file) => (
                        <button
                          key={file.id}
                          onClick={() => setSelectedFileJob(file)}
                          aria-label={t('usage.viewDocumentJob', { filename: formatFilename(file.filename) })}
                          className="min-w-0 rounded-lg border border-border bg-bg-base p-3 text-left transition-colors hover:border-primary/60 hover:bg-bg-surface"
                        >
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-medium text-text-main">{formatFilename(file.filename)}</p>
                            <span className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted">
                              {file.status}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                            <span>{t('usage.attempts', { count: file.attempts, max: file.max_attempts })}</span>
                            <span>{formatNumber(file.progress)}%</span>
                            <span>{formatDateTime(file.updated_at)}</span>
                          </div>
                          {file.error_message && (
                            <p className="mt-2 line-clamp-2 break-words text-xs text-red-300">{file.error_message}</p>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="min-w-0 rounded-lg border border-border bg-bg-sidebar">
              <div className="flex items-center justify-between border-b border-border p-4">
                <div>
                  <h2 className="font-semibold">{t('usage.conversations')}</h2>
                  <p className="text-xs text-text-muted">{t('usage.conversationsHint')}</p>
                </div>
              </div>

              {isLoadingOverview ? (
                <div className="space-y-3 p-4">
                  {[1, 2, 3, 4].map((item) => (
                    <Skeleton key={item} className="h-16 w-full rounded-lg" />
                  ))}
                </div>
              ) : conversations.length === 0 ? (
                <div className="flex flex-col items-center gap-3 p-10 text-center text-text-muted">
                  <MessageSquare className="h-10 w-10 opacity-30" />
                  <p>{t('usage.noConversations')}</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {conversations.map((conversation) => {
                    const isSelected = selectedConversationId === conversation.id;

                        return (
                          <button
                            key={conversation.id}
                            onClick={() => fetchConversationTrace(conversation.id)}
                            aria-label={t('usage.viewConversationTrace', {
                              title: conversation.title === 'New Chat' ? t('sidebar.newChat') : conversation.title,
                            })}
                            className={`w-full p-4 text-left transition-colors hover:bg-bg-surface ${isSelected ? 'bg-primary/10' : ''}`}
                          >
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium text-text-main">
                                {conversation.title === 'New Chat' ? t('sidebar.newChat') : conversation.title}
                              </span>
                              {conversation.enable_rag && (
                                <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase text-primary">
                                  RAG
                                </span>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                              <span>{t('usage.workspace')}: {conversation.project_space_name || t('workspace.fallbackName')}</span>
                              <span>{t('usage.lastActivity')}: {formatDateTime(conversation.last_message_at || conversation.updated_at)}</span>
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-center text-xs md:w-60">
                            <div className="rounded border border-border bg-bg-base px-2 py-1">
                              <p className="font-semibold text-text-main">{formatNumber(conversation.message_count)}</p>
                              <p className="text-text-muted">{t('usage.messages')}</p>
                            </div>
                            <div className="rounded border border-border bg-bg-base px-2 py-1">
                              <p className="font-semibold text-text-main">{formatNumber(conversation.source_count)}</p>
                              <p className="text-text-muted">{t('usage.sources')}</p>
                            </div>
                            <div className="rounded border border-border bg-bg-base px-2 py-1">
                              <p className="font-semibold text-text-main">{formatNumber(conversation.user_message_count)}</p>
                              <p className="text-text-muted">{t('usage.user')}</p>
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
          </section>
        </div>
      </div>

      <Modal
        isOpen={!!selectedFileJob}
        onClose={() => setSelectedFileJob(null)}
        title={t('usage.documentJobDetails')}
        maxWidth="2xl"
        footer={
          <button
            onClick={() => setSelectedFileJob(null)}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
          >
            {t('common.close')}
          </button>
        }
      >
        {selectedFileJob && (
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-text-muted">{t('knowledge.fileName')}</p>
              <p className="mt-1 break-words text-base font-semibold">{formatFilename(selectedFileJob.filename)}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('knowledge.status')}</p>
                <p className="mt-1 text-text-main">{selectedFileJob.status}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('usage.progress')}</p>
                <p className="mt-1 text-text-main">{formatNumber(selectedFileJob.progress)}%</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('usage.attemptCount')}</p>
                <p className="mt-1 text-text-main">{t('usage.attempts', { count: selectedFileJob.attempts, max: selectedFileJob.max_attempts })}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('usage.lastAttempt')}</p>
                <p className="mt-1 text-text-main">{formatDateTime(selectedFileJob.last_attempt_at)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('usage.updatedAt')}</p>
                <p className="mt-1 text-text-main">{formatDateTime(selectedFileJob.updated_at)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('usage.nextRetry')}</p>
                <p className="mt-1 text-text-main">{formatDateTime(selectedFileJob.next_attempt_at)}</p>
              </div>
            </div>
            {selectedFileJob.error_message && (
              <div>
                <p className="mb-1 text-xs font-medium text-text-muted">{t('usage.errorMessage')}</p>
                <p className="whitespace-pre-wrap break-words rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm leading-6 text-red-300">
                  {selectedFileJob.error_message}
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isTraceModalOpen}
        onClose={() => setIsTraceModalOpen(false)}
        title={t('usage.conversationDetails')}
        maxWidth="3xl"
        footer={
          <button
            onClick={() => setIsTraceModalOpen(false)}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
          >
            {t('common.close')}
          </button>
        }
      >
        {traceError && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {traceError}
          </div>
        )}

        {isLoadingTrace && (
          <div className="space-y-3">
            {[1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        )}

        {activeConversation && !isLoadingTrace && (
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-text-muted">{t('usage.traceConversation')}</p>
              <p className="mt-1 break-words text-base font-semibold">
                {activeConversation.title === 'New Chat' ? t('sidebar.newChat') : activeConversation.title}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
              <div className="rounded border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('usage.createdAt')}</p>
                <p className="mt-1 text-text-main">{formatDateTime(activeConversation.created_at)}</p>
              </div>
              <div className="rounded border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('usage.updatedAt')}</p>
                <p className="mt-1 text-text-main">{formatDateTime(activeConversation.updated_at)}</p>
              </div>
              <div className="rounded border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('usage.model')}</p>
                <p className="mt-1 text-text-main">{activeConversation.model || 'deepseek-chat'}</p>
              </div>
              <div className="rounded border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('usage.sources')}</p>
                <p className="mt-1 text-text-main">{formatNumber(activeConversation.source_count)}</p>
              </div>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-text-muted">{t('usage.messageTimeline')}</h3>
              {conversationTrace?.messages.length === 0 ? (
                <p className="rounded-lg border border-border bg-bg-base p-4 text-sm text-text-muted">{t('usage.noMessages')}</p>
              ) : (
                <div className="space-y-3">
                  {conversationTrace?.messages.map((message) => {
                    const Icon = message.role === 'assistant' ? Bot : message.role === 'user' ? UserRound : MessageSquare;
                    const roleLabel = t(`usage.role.${message.role}`);

                    return (
                      <div key={message.id} className="rounded-lg border border-border bg-bg-base p-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <Icon className="h-4 w-4 shrink-0 text-primary" />
                            <span className="text-sm font-medium">{roleLabel}</span>
                          </div>
                          <span className="shrink-0 text-[11px] text-text-muted">{formatDateTime(message.created_at)}</span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-text-muted">
                          {message.content_preview}
                          {message.content_length > message.content_preview.length ? '...' : ''}
                        </p>
                        {(message.source_count > 0 || message.source_filenames.length > 0) && (
                          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2 text-xs text-text-muted">
                            <span>{t('usage.sources')}: {formatNumber(message.source_count)}</span>
                            {message.source_filenames.map((filename) => (
                              <span key={filename} className="max-w-full truncate rounded border border-border px-2 py-0.5">
                                {formatFilename(filename)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

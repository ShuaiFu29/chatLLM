import { memo, lazy, Suspense, useState } from 'react';
import { AlertTriangle, Bot, RefreshCw, Trash2, Check, Copy, Search, BookOpen, FileText, Loader2, GitBranch, Pencil, Gauge, Route, MapPin } from 'lucide-react';
import type { Message } from '../stores/useChatStore';
import { isOptimisticMessageId } from '../stores/useChatStore';
import { useTranslation } from 'react-i18next';
import DocumentViewerModal, { type DocumentReference } from './DocumentViewerModal';
import { getRagTraceStatusLabel, getRagTraceStepLabel } from '../lib/ragTraceLabels';
import { getAvatarUrl } from '../lib/avatar';
import { getSourceLocatorLabel } from '../lib/sourceLocator';
import AgentRunTimeline from '../features/agents/AgentRunTimeline';
import { buildPersistedAgentEvents, mergeAgentEvents } from '../features/agents/agentRunEvents';

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
  onBranch?: (id: string) => void;
  onEditAsDraft?: (content: string) => void;
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
  onBranch,
  onEditAsDraft,
  copiedMessageId,
  enableRag
}: ChatMessageProps) => {
  const { t } = useTranslation();
  const [selectedSourceDocument, setSelectedSourceDocument] = useState<DocumentReference | null>(null);

  // Optimistic messages exist only in this browser. Branching or deleting them
  // would post an id the server has never seen.
  const isOptimistic = isOptimisticMessageId(msg.id);
  const traceSummary = msg.traceSummary || msg.rag_trace || null;
  const qualitySummary = msg.qualitySummary || traceSummary?.quality || null;
  const traceSteps = traceSummary?.trace_steps || [];
  const plannedQueries = traceSummary?.planned_queries || [];
  const ragRunId = msg.ragRunId || msg.rag_run_id;
  const agentRunId = msg.agentRunId || msg.agent_run_id;
  const persistedAgentEvents = agentRunId
    ? buildPersistedAgentEvents({
        runId: agentRunId,
        status: msg.agent_run_status,
        steps: msg.agent_steps,
        approvals: msg.agent_approvals,
        grounding: msg.agent_grounding,
      })
    : [];
  const agentEvents = mergeAgentEvents(msg.agentEvents, persistedAgentEvents);
  const agentGrounding = msg.agent_grounding
    || [...agentEvents].reverse().find((event) => event.type === 'run.completed')?.grounding;
  const agentRunActive = ['queued', 'running', 'waiting_approval', 'waiting_subagent'].includes(msg.agent_run_status || '')
    || (isSending && isLast);
  const cacheStatus = traceSummary?.cache?.status;

  const formatScore = (score?: number) => `${Math.round((score || 0) * 100)}%`;
  const formatEvidenceLabel = (label?: string) => {
    if (label === 'strong') return t('chat.ragEvidenceStrong');
    if (label === 'partial') return t('chat.ragEvidencePartial');
    return t('chat.ragEvidenceWeak');
  };
  const formatSupportLabel = (label?: string) => {
    if (label === 'supported') return t('chat.ragSupportSupported');
    if (label === 'partial') return t('chat.ragSupportPartial');
    return t('chat.ragSupportUnsupported');
  };
  const formatRiskLabel = (level?: string) => {
    if (level === 'high') return t('chat.ragRiskHigh');
    if (level === 'medium') return t('chat.ragRiskMedium');
    if (level === 'low') return t('chat.ragRiskLow');
    return t('chat.ragRiskUnknown');
  };
  const formatAnswerGroundingLabel = (label?: string) => {
    if (label === 'supported') return t('chat.ragAnswerGroundingSupported');
    if (label === 'partial') return t('chat.ragAnswerGroundingPartial');
    return t('chat.ragAnswerGroundingUnsupported');
  };
  const formatCacheLabel = (status?: string) => {
    if (status === 'hit') return t('chat.ragCacheHit');
    if (status === 'partial') return t('chat.ragCachePartial');
    if (status === 'miss') return t('chat.ragCacheMiss');
    return '';
  };

  return (
    <>
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
              {isSending && isLast && !msg.content && enableRag !== false && !msg.ragSkipped && (
                <div className="flex items-center gap-2 text-text-muted mb-2 animate-pulse">
                  <Search className="w-4 h-4" />
                  <span className="text-sm">{t('chat.searchingWorkspaceDocuments')}</span>
                </div>
              )}

              {/* Content */}
              {agentRunId && agentEvents.length > 0 && (
                <AgentRunTimeline runId={agentRunId} events={agentEvents} active={agentRunActive} />
              )}

              {(msg.content || !isSending) && (
                <div className="text-sm md:text-base min-h-[24px]">
                  <Suspense fallback={
                    <div className="flex items-center gap-2 text-text-muted">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-xs">{t('chat.loadingContent')}</span>
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

              {agentGrounding && (
                <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-text-muted">
                  {t('agents.groundingStatus', {
                    status: t(`agents.groundingStatuses.${agentGrounding.status}`, {
                      defaultValue: agentGrounding.status,
                    }),
                    score: Math.round(Number(agentGrounding.score || 0) * 100),
                  })}
                </div>
              )}

              {qualitySummary && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3 text-xs text-text-muted">
                  <span className="inline-flex items-center gap-1.5 font-medium text-text-main">
                    <Gauge className="h-3.5 w-3.5 text-primary" />
                    {t('chat.ragQuality')}: {formatScore(qualitySummary.overall_score)}
                  </span>
                  <span>
                    {t('chat.ragEvidence')}: {formatEvidenceLabel(qualitySummary.evidence_label)}
                  </span>
                  {qualitySummary.support_label && (
                    <span>
                      {t('chat.ragSupport')}: {formatSupportLabel(qualitySummary.support_label)}
                      {qualitySummary.verification_score !== undefined ? ` · ${formatScore(qualitySummary.verification_score)}` : ''}
                    </span>
                  )}
                  {qualitySummary.risk_level && (
                    <span>
                      {t('chat.ragRisk')}: {formatRiskLabel(qualitySummary.risk_level)}
                    </span>
                  )}
                  {qualitySummary.answer_grounding_status && qualitySummary.answer_grounding_status !== 'not_applicable' && (
                    <span>
                      {t('chat.ragAnswerGrounding')}: {formatAnswerGroundingLabel(qualitySummary.answer_grounding_status)}
                      {qualitySummary.answer_grounding_score !== undefined ? ` · ${formatScore(qualitySummary.answer_grounding_score)}` : ''}
                    </span>
                  )}
                  {cacheStatus && cacheStatus !== 'disabled' && (
                    <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-primary">
                      {formatCacheLabel(cacheStatus)}
                    </span>
                  )}
                  {ragRunId && <span className="font-mono text-[10px] text-text-muted">#{String(ragRunId).slice(0, 8)}</span>}
                </div>
              )}

              {msg.ragWarning && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-200">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('chat.ragRetrievalFailed')}</span>
                </div>
              )}

              {traceSummary && (
                <details className="mt-2 border-t border-border/40 pt-2 text-xs text-text-muted">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 text-text-main hover:text-primary">
                    <Route className="h-3.5 w-3.5 text-primary" />
                    <span>{t('chat.ragTrace')}</span>
                    <span className="text-text-muted">({traceSteps.length})</span>
                  </summary>
                  <div className="mt-2 space-y-2">
                    {plannedQueries.length > 0 && (
                      <div>
                        <p className="mb-1 font-medium text-text-main">{t('chat.ragPlannedQueries')}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {plannedQueries.map((query, index) => (
                            <span key={`${query}-${index}`} className="rounded-full bg-bg-surface px-2 py-1 text-[11px]">
                              {query}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {traceSteps.length > 0 && (
                      <div className="grid gap-1">
                        {traceSteps.map((step, index) => (
                          <div key={`${step.step_type}-${index}`} className="flex items-center justify-between gap-3">
                            <span className="truncate">{getRagTraceStepLabel(t, step.step_type)}</span>
                            <span className="shrink-0">{getRagTraceStatusLabel(t, step.status)} · {step.duration_ms}ms</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              )}

              {/* Enhanced Sources Display */}
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-4 pt-3 border-t border-border/50">
                  <div className="flex items-center gap-2 mb-2">
                    <BookOpen className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                      {t('chat.sources')}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {msg.sources.slice(0, 4).map((source, idx) => {
                      const locatorLabel = getSourceLocatorLabel(source.source_locator, source.document_kind);
                      const locatorText = locatorLabel ? t(locatorLabel.key, locatorLabel.values) : '';
                      const sourceContent = (
                        <>
                          <div className="p-1.5 rounded-md bg-primary/10 text-primary group-hover/source:bg-primary group-hover/source:text-white transition-colors">
                            <FileText className="w-3.5 h-3.5" />
                          </div>
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-xs font-medium text-text-main">{source.filename.trim()}</span>
                              <span className="shrink-0 text-[10px] text-text-muted">
                                {Math.round(source.similarity * 100)}%
                                {source.chunk_index !== undefined ? ` · #${source.chunk_index + 1}` : ''}
                              </span>
                            </div>
                            {locatorText && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-text-muted">
                                <MapPin className="h-3 w-3 shrink-0" />
                                {locatorText}
                              </span>
                            )}
                            {source.file_id ? (
                              <span className="text-[11px] text-primary">{t('chat.viewOriginalDocument')}</span>
                            ) : source.content ? (
                              <p className="line-clamp-2 text-[11px] leading-relaxed text-text-muted">
                                {source.content}
                              </p>
                            ) : null}
                          </div>
                        </>
                      );

                      return source.file_id ? (
                        <button
                          key={`${source.chunk_id || source.filename}-${idx}`}
                          data-testid={`source-${msg.id}-${idx}`}
                          onClick={() => setSelectedSourceDocument({
                            id: source.file_id!,
                            filename: source.filename,
                            citationContent: source.content,
                            chunkIndex: source.chunk_index,
                            document_kind: source.document_kind,
                            conversion_generation_id: source.conversion_generation_id,
                            source_unit_ids: source.source_unit_ids,
                            source_locator: source.source_locator,
                          })}
                          className="group/source flex items-start gap-2 rounded-lg border border-border/50 bg-bg-surface/50 p-2 text-left transition-all hover:border-primary/60 hover:bg-bg-surface"
                          aria-label={t('chat.viewOriginalDocument')}
                        >
                          {sourceContent}
                        </button>
                      ) : (
                        <div
                          key={`${source.chunk_id || source.filename}-${idx}`}
                          className="group/source flex cursor-default items-start gap-2 rounded-lg border border-border/50 bg-bg-surface/50 p-2 transition-all hover:bg-bg-surface"
                        >
                          {sourceContent}
                        </div>
                      );
                    })}
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
            title={t('common.copy')}
            aria-label={t('common.copy')}
          >
            {copiedMessageId === msg.id ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
          </button>

          {msg.role === 'user' && onEditAsDraft && (
            <button
              onClick={() => onEditAsDraft(msg.content)}
              className="p-1 text-text-muted hover:text-primary hover:bg-bg-surface rounded transition-colors"
              title={t('chat.editAsDraft')}
              aria-label={t('chat.editAsDraft')}
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}

          {onBranch && !isOptimistic && (
            <button
              onClick={() => onBranch(msg.id)}
              className="p-1 text-text-muted hover:text-primary hover:bg-bg-surface rounded transition-colors"
              title={t('chat.branchFromMessage')}
              aria-label={t('chat.branchFromMessage')}
            >
              <GitBranch className="w-3 h-3" />
            </button>
          )}

          {/* Regenerate only for the latest assistant message */}
          {isLast && !isSending && msg.role === 'assistant' && (
            <button
              onClick={onRegenerate}
              className="p-1 text-text-muted hover:text-primary hover:bg-bg-surface rounded transition-colors"
              title={t('chat.regenerate')}
              aria-label={t('chat.regenerate')}
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}

          <button
            onClick={() => onDelete(msg.id)}
            disabled={isOptimistic}
            className="p-1 text-text-muted hover:text-red-500 hover:bg-bg-surface rounded transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            title={t('common.delete')}
            aria-label={t('common.delete')}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {msg.role === 'user' && (
        <img
          src={getAvatarUrl(userAvatar, userName, 64)}
          alt="User"
          className="w-8 h-8 rounded-full bg-bg-surface shrink-0 order-3 object-cover"
          loading="lazy"
          onError={(e) => (e.currentTarget.src = getAvatarUrl(null, userName, 64))}
        />
      )}
    </div>
    <DocumentViewerModal
      document={selectedSourceDocument}
      onClose={() => setSelectedSourceDocument(null)}
    />
    </>
  );
});

export default ChatMessage;

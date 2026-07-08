import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { AlertCircle, FileSearch, Loader2, Network, RefreshCw, Route, Search } from 'lucide-react';
import api from '../lib/api';
import Modal from '../components/Modal';
import Skeleton from '../components/Skeleton';
import SelectField from '../components/SelectField';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';
import { getRagTraceStatusLabel, getRagTraceStepLabel } from '../lib/ragTraceLabels';

const MarkdownRenderer = lazy(() => import('../components/MarkdownRenderer'));

interface RetrievalTraceStep {
  step_type?: string;
  status?: string;
  duration_ms?: number;
}

interface RetrievalIntent {
  type?: string;
  complexity?: string;
  routes?: string[];
}

interface RetrievalQuality {
  retrieval_score?: number;
  citation_score?: number;
  evidence_score?: number;
  overall_score?: number;
  evidence_label?: string;
  support_label?: string;
  verification_score?: number;
  risk_level?: string;
  risk_factors?: string[];
  missing_markers?: string[];
  matched_markers?: string[];
}

interface RetrievalMetadata {
  filename?: string | null;
  file_id?: string | null;
  chunk_id?: string | null;
  chunk_index?: number | string | null;
  retrieval_mode?: string;
  rrf_score?: number;
  retrieval_channels?: string[];
  channel_ranks?: Record<string, number>;
  channel_scores?: Record<string, number>;
  graph_entities?: string[];
}

interface RetrievalResult {
  id?: string;
  chunk_id?: string;
  file_id?: string;
  filename?: string;
  content?: string;
  score?: number;
  similarity?: number;
  agentic_score?: number;
  rerank_score?: number;
  reranker?: string;
  pre_rerank_rank?: number;
  metadata?: RetrievalMetadata;
}

interface RetrievalInspectResponse {
  run_id?: string;
  mode?: string;
  intent?: RetrievalIntent;
  planned_queries?: string[];
  results?: RetrievalResult[];
  trace_steps?: RetrievalTraceStep[];
  quality?: RetrievalQuality;
  insufficient_evidence?: boolean;
  answer_guidance?: string;
  cache?: {
    status?: string;
    hit_type?: string;
    reused_count?: number;
    query_similarity?: number;
  };
}

const stripMarkdownExtension = (value?: string | null) => (
  value || ''
).replace(/\.(?:md|markdown)$/i, '').trim();

const formatDecimal = (value?: number) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  return value >= 1 ? value.toFixed(2) : value.toFixed(4);
};

interface RetrievalSourceListProps {
  sources: RetrievalResult[];
  getSourceName: (source: RetrievalResult) => string;
  t: TFunction;
}

function RetrievalSourceList({ sources, getSourceName, t }: RetrievalSourceListProps) {
  if (sources.length === 0) {
    return <div className="p-6 text-sm text-text-muted">{t('ragWorkbench.emptySources')}</div>;
  }

  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-bg-sidebar">
      {sources.map((source, index) => {
        const metadata = source.metadata || {};
        const channels = metadata.retrieval_channels || [];
        const ranks = metadata.channel_ranks || {};
        const scores = metadata.channel_scores || {};
        const sourceKey = source.id || source.chunk_id || `${getSourceName(source)}-${index}`;

        return (
          <div key={sourceKey} className="p-4">
            <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{getSourceName(source)}</p>
                <p className="mt-1 text-xs text-text-muted">
                  {t('ragWorkbench.sourceRank', { rank: index + 1 })}
                  {metadata.chunk_index !== undefined && metadata.chunk_index !== null ? ` · #${metadata.chunk_index}` : ''}
                  {metadata.retrieval_mode ? ` · ${metadata.retrieval_mode}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5 text-[11px] text-text-muted">
                <span className="rounded border border-border bg-bg-base px-2 py-0.5">
                  RRF {formatDecimal(metadata.rrf_score)}
                </span>
                <span className="rounded border border-border bg-bg-base px-2 py-0.5">
                  {t('ragWorkbench.rerankScore')} {formatDecimal(source.rerank_score)}
                </span>
              </div>
            </div>

            <div className="max-h-40 overflow-auto rounded-lg border border-border bg-bg-base p-3">
              <Suspense fallback={<div className="text-sm text-text-muted">{t('common.loading')}</div>}>
                <MarkdownRenderer content={source.content || t('usage.notAvailable')} />
              </Suspense>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {channels.map((channel) => (
                <span key={`${sourceKey}-${channel}`} className="rounded border border-border bg-bg-base px-2 py-1 text-[11px] text-text-muted">
                  {channel}
                  {ranks[channel] !== undefined ? ` #${ranks[channel]}` : ''}
                  {scores[channel] !== undefined ? ` · ${formatDecimal(scores[channel])}` : ''}
                </span>
              ))}
              {(metadata.graph_entities || []).slice(0, 6).map((entity) => (
                <span key={`${sourceKey}-${entity}`} className="rounded border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] text-primary">
                  {entity}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function RetrievalLabPage() {
  const { t } = useTranslation();
  const { projectSpaces, currentProjectSpaceId, fetchProjectSpaces } = useProjectSpaceStore();
  const initialQuery = useMemo(() => new URLSearchParams(window.location.search).get('q')?.trim() || '', []);
  const hasAutoRunFromUrl = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [selectedProjectSpaceId, setSelectedProjectSpaceId] = useState('');
  const [limit, setLimit] = useState(10);
  const [result, setResult] = useState<RetrievalInspectResponse | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isSourceModalOpen, setIsSourceModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchProjectSpaces();
  }, [fetchProjectSpaces]);

  useEffect(() => {
    if (!selectedProjectSpaceId && currentProjectSpaceId) {
      setSelectedProjectSpaceId(currentProjectSpaceId);
    }
  }, [currentProjectSpaceId, selectedProjectSpaceId]);

  const inspectRetrieval = useCallback(async (overrideQuery?: string) => {
    const trimmedQuery = (overrideQuery ?? query).trim();
    if (!trimmedQuery || isInspecting) return;

    setIsInspecting(true);
    setError(null);

    try {
      const { data } = await api.post<RetrievalInspectResponse>('/rag-workbench/inspect', {
        query: trimmedQuery,
        project_space_id: selectedProjectSpaceId || undefined,
        limit,
      });
      setResult(data);
    } catch (inspectError) {
      console.error('Failed to inspect RAG retrieval:', inspectError);
      setError(t('ragWorkbench.loadFailed'));
    } finally {
      setIsInspecting(false);
    }
  }, [isInspecting, limit, query, selectedProjectSpaceId, t]);

  useEffect(() => {
    if (!initialQuery || hasAutoRunFromUrl.current) return;

    hasAutoRunFromUrl.current = true;
    void inspectRetrieval(initialQuery);
  }, [initialQuery, inspectRetrieval]);

  const plannedQueries = useMemo(() => result?.planned_queries || [], [result?.planned_queries]);
  const traceSteps = useMemo(() => result?.trace_steps || [], [result?.trace_steps]);
  const sources = useMemo(() => result?.results || [], [result?.results]);
  const routes = useMemo(() => result?.intent?.routes || [], [result?.intent?.routes]);
  const groupedChannelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of sources) {
      const channels = source.metadata?.retrieval_channels || [];
      const fallback = source.metadata?.retrieval_mode ? [source.metadata.retrieval_mode] : [];
      for (const channel of channels.length > 0 ? channels : fallback) {
        counts.set(channel, (counts.get(channel) || 0) + 1);
      }
    }
    return Array.from(counts.entries());
  }, [sources]);

  const getSourceName = useCallback((source: RetrievalResult) => {
    const metadata = source.metadata;
    return stripMarkdownExtension(metadata?.filename || source.filename || metadata?.file_id || source.file_id || t('ragWorkbench.unknownSource'));
  }, [t]);

  const formatCacheStatus = useCallback((status?: string) => {
    if (status === 'hit') return t('ragWorkbench.cacheHit');
    if (status === 'partial') return t('ragWorkbench.cachePartial');
    if (status === 'miss') return t('ragWorkbench.cacheMiss');
    return t('ragWorkbench.cacheDisabled');
  }, [t]);

  const formatSupportStatus = useCallback((label?: string) => {
    if (label === 'supported') return t('chat.ragSupportSupported');
    if (label === 'partial') return t('chat.ragSupportPartial');
    if (label === 'unsupported') return t('chat.ragSupportUnsupported');
    return '-';
  }, [t]);

  const formatRiskLevel = useCallback((level?: string) => {
    if (level === 'high') return t('chat.ragRiskHigh');
    if (level === 'medium') return t('chat.ragRiskMedium');
    if (level === 'low') return t('chat.ragRiskLow');
    return t('chat.ragRiskUnknown');
  }, [t]);

  const handleRefresh = useCallback(() => {
    if (query.trim()) void inspectRetrieval();
  }, [inspectRetrieval, query]);

  return (
    <div className="flex h-full flex-col bg-bg-base text-text-main transition-colors duration-300">
      <div className="hidden items-center justify-between gap-4 border-b border-border bg-bg-sidebar px-4 py-3 md:flex">
        <div className="flex items-center gap-2">
          <FileSearch className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">{t('ragWorkbench.title')}</h1>
            <p className="text-sm text-text-muted">{t('ragWorkbench.subtitle')}</p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!query.trim() || isInspecting}
          className="flex items-center gap-2 rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text-muted transition-colors hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isInspecting ? 'animate-spin' : ''}`} />
          {t('usage.refresh')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-4">
        <div className="mx-auto flex max-w-7xl flex-col gap-4">
          <div className="md:hidden">
            <h1 className="text-xl font-semibold">{t('ragWorkbench.title')}</h1>
            <p className="mt-1 text-sm text-text-muted">{t('ragWorkbench.subtitle')}</p>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <section className="rounded-lg border border-border bg-bg-sidebar p-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_120px]">
              <label className="min-w-0">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('ragWorkbench.queryLabel')}
                </span>
                <textarea
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      void inspectRetrieval();
                    }
                  }}
                  className="min-h-20 w-full resize-y rounded-lg border border-border bg-bg-base px-3 py-2.5 text-sm leading-6 text-text-main outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                  placeholder={t('ragWorkbench.queryPlaceholder')}
                />
              </label>

              <label>
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('usage.workspace')}
                </span>
                <SelectField
                  value={selectedProjectSpaceId}
                  onChange={(event) => setSelectedProjectSpaceId(event.target.value)}
                  className="w-full"
                  selectClassName="h-10"
                >
                  <option value="">{t('ragEval.allWorkspaces')}</option>
                  {projectSpaces.map((space) => (
                    <option key={space.id} value={space.id}>{space.name}</option>
                  ))}
                </SelectField>
              </label>

              <label>
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('ragWorkbench.limit')}
                </span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={limit}
                  onChange={(event) => setLimit(Math.min(30, Math.max(1, Number(event.target.value) || 1)))}
                  className="h-10 w-full rounded-lg border border-border bg-bg-base px-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2 text-xs text-text-muted">
                <span className="rounded border border-border bg-bg-base px-2 py-1">Milvus</span>
                <span className="rounded border border-border bg-bg-base px-2 py-1">Elasticsearch BM25</span>
                <span className="rounded border border-border bg-bg-base px-2 py-1">Neo4j</span>
                <span className="rounded border border-border bg-bg-base px-2 py-1">RRF</span>
              </div>
              <button
                onClick={() => void inspectRetrieval()}
                disabled={!query.trim() || isInspecting}
                className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isInspecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {isInspecting ? t('common.loading') : t('ragWorkbench.inspect')}
              </button>
            </div>
          </section>

          {isInspecting && !result ? (
            <div className="grid gap-3 lg:grid-cols-3">
              <Skeleton className="h-32 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
            </div>
          ) : result ? (
            <>
              <section className="grid gap-2 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium text-text-muted">{t('ragWorkbench.intent')}</p>
                  <p className="mt-1 truncate text-base font-semibold">{result.intent?.type || '-'}</p>
                  <p className="mt-1 text-xs text-text-muted">{result.intent?.complexity || '-'}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium text-text-muted">{t('ragWorkbench.retrievalChannels')}</p>
                  <p className="mt-1 text-base font-semibold">{groupedChannelCounts.length}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {groupedChannelCounts.map(([channel, count]) => (
                      <span key={channel} className="rounded border border-border bg-bg-base px-2 py-0.5 text-[11px] text-text-muted">
                        {channel} · {count}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium text-text-muted">{t('ragWorkbench.overallScore')}</p>
                  <p className="mt-1 text-base font-semibold">{formatDecimal(result.quality?.overall_score)}</p>
                  <p className="mt-1 text-xs text-text-muted">{result.quality?.evidence_label || '-'}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium text-text-muted">{t('ragWorkbench.verificationScore')}</p>
                  <p className="mt-1 text-base font-semibold">{formatDecimal(result.quality?.verification_score)}</p>
                  <p className="mt-1 text-xs text-text-muted">{t('ragWorkbench.supportStatus')}: {formatSupportStatus(result.quality?.support_label)}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium text-text-muted">{t('ragWorkbench.riskLevel')}</p>
                  <p className="mt-1 text-base font-semibold">{formatRiskLevel(result.quality?.risk_level)}</p>
                  <p className="mt-1 truncate text-xs text-text-muted">
                    {(result.quality?.risk_factors || []).slice(0, 3).join(' · ') || '-'}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium text-text-muted">{t('ragWorkbench.resultCount')}</p>
                  <p className="mt-1 text-base font-semibold">{sources.length}</p>
                  <p className="mt-1 text-xs text-text-muted">{result.mode || '-'}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium text-text-muted">{t('ragWorkbench.cacheStatus')}</p>
                  <p className="mt-1 text-base font-semibold">{formatCacheStatus(result.cache?.status)}</p>
                  <p className="mt-1 truncate text-xs text-text-muted">
                    {result.cache?.hit_type || result.cache?.reused_count ? `${result.cache?.hit_type || '-'} · ${result.cache?.reused_count || 0}` : '-'}
                  </p>
                </div>
              </section>

              <section className="grid gap-3 xl:grid-cols-[minmax(0,0.48fr)_minmax(0,0.52fr)]">
                <div className="space-y-3">
                  <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                    <div className="mb-3 flex items-center gap-2">
                      <Route className="h-4 w-4 text-primary" />
                      <h2 className="text-sm font-semibold">{t('ragWorkbench.plannedQueries')}</h2>
                    </div>
                    {plannedQueries.length === 0 ? (
                      <p className="text-sm text-text-muted">{t('ragWorkbench.emptyPlannedQueries')}</p>
                    ) : (
                      <div className="space-y-2">
                        {plannedQueries.map((plannedQuery, index) => (
                          <div key={`${plannedQuery}-${index}`} className="rounded-lg border border-border bg-bg-base p-3 text-sm">
                            <span className="mr-2 text-xs text-text-muted">#{index + 1}</span>
                            {plannedQuery}
                          </div>
                        ))}
                      </div>
                    )}
                    {routes.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {routes.map((route) => (
                          <span key={route} className="rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                            {route}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                    <div className="mb-3 flex items-center gap-2">
                      <Network className="h-4 w-4 text-primary" />
                      <h2 className="text-sm font-semibold">{t('ragWorkbench.traceSteps')}</h2>
                    </div>
                    {traceSteps.length === 0 ? (
                      <p className="text-sm text-text-muted">{t('ragWorkbench.emptyTrace')}</p>
                    ) : (
                      <div className="space-y-2">
                        {traceSteps.map((step, index) => (
                          <div key={`${step.step_type || 'step'}-${index}`} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-base px-3 py-2 text-xs">
                            <span className="min-w-0 truncate text-text-main">{getRagTraceStepLabel(t, step.step_type)}</span>
                            <span className="shrink-0 text-text-muted">
                              {getRagTraceStatusLabel(t, step.status)} · {step.duration_ms ?? 0}ms
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="font-semibold">{t('ragWorkbench.sources')}</h2>
                      <p className="mt-1 text-xs text-text-muted">
                        {t('ragWorkbench.sourcesSummary', { count: sources.length, channels: groupedChannelCounts.length })}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsSourceModalOpen(true)}
                      disabled={sources.length === 0}
                      className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <FileSearch className="h-4 w-4" />
                      {t('ragWorkbench.openSources', { count: sources.length })}
                    </button>
                  </div>

                  {sources.length === 0 ? (
                    <div className="mt-3 rounded-lg border border-dashed border-border bg-bg-base p-4 text-sm text-text-muted">
                      {t('ragWorkbench.emptySources')}
                    </div>
                  ) : (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs font-medium text-text-muted">{t('ragWorkbench.topSources')}</p>
                      {sources.slice(0, 4).map((source, index) => (
                        <div
                          key={source.id || source.chunk_id || `${getSourceName(source)}-${index}`}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-base px-3 py-2 text-sm"
                        >
                          <span className="min-w-0 truncate font-medium text-text-main">{getSourceName(source)}</span>
                          <span className="shrink-0 text-xs text-text-muted">
                            {t('ragWorkbench.sourceRank', { rank: index + 1 })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </>
          ) : (
            <section className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-sidebar p-8 text-center">
              <FileSearch className="mb-3 h-10 w-10 text-primary" />
              <p className="text-sm text-text-muted">{t('ragWorkbench.emptyState')}</p>
            </section>
          )}
        </div>
      </div>
      <Modal
        isOpen={isSourceModalOpen && sources.length > 0}
        onClose={() => setIsSourceModalOpen(false)}
        title={t('ragWorkbench.sources')}
        maxWidth="5xl"
      >
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span className="rounded border border-border bg-bg-base px-2 py-1">
            {t('ragWorkbench.sourcesSummary', { count: sources.length, channels: groupedChannelCounts.length })}
          </span>
          {groupedChannelCounts.map(([channel, count]) => (
            <span key={channel} className="rounded border border-border bg-bg-base px-2 py-1">
              {channel} · {count}
            </span>
          ))}
        </div>
        <RetrievalSourceList sources={sources} getSourceName={getSourceName} t={t} />
      </Modal>
    </div>
  );
}

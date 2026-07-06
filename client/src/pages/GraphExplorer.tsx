import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, GitFork, Loader2, Network, Search } from 'lucide-react';
import api from '../lib/api';
import Skeleton from '../components/Skeleton';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';

interface GraphMetadata {
  filename?: string | null;
  file_id?: string | null;
  chunk_id?: string | null;
  chunk_index?: number | string | null;
  retrieval_mode?: string;
  graph_entities?: string[];
}

interface GraphResult {
  id?: string;
  chunk_id?: string;
  file_id?: string;
  filename?: string;
  content?: string;
  score?: number;
  metadata?: GraphMetadata;
}

interface GraphSearchResponse {
  results?: GraphResult[];
}

const stripMarkdownExtension = (value?: string | null) => (
  value || ''
).replace(/\.(?:md|markdown)$/i, '').trim();

const formatDecimal = (value?: number) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  return value >= 1 ? value.toFixed(2) : value.toFixed(4);
};

export default function GraphExplorerPage() {
  const { t } = useTranslation();
  const { projectSpaces, currentProjectSpaceId, fetchProjectSpaces } = useProjectSpaceStore();
  const initialQuery = useMemo(() => new URLSearchParams(window.location.search).get('q')?.trim() || '', []);
  const hasAutoRunFromUrl = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [selectedProjectSpaceId, setSelectedProjectSpaceId] = useState('');
  const [limit, setLimit] = useState(12);
  const [results, setResults] = useState<GraphResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchProjectSpaces();
  }, [fetchProjectSpaces]);

  useEffect(() => {
    if (!selectedProjectSpaceId && currentProjectSpaceId) {
      setSelectedProjectSpaceId(currentProjectSpaceId);
    }
  }, [currentProjectSpaceId, selectedProjectSpaceId]);

  const searchGraph = useCallback(async (overrideQuery?: string) => {
    const trimmedQuery = (overrideQuery ?? query).trim();
    if (!trimmedQuery || isSearching) return;

    setIsSearching(true);
    setError(null);

    try {
      const { data } = await api.post<GraphSearchResponse>('/rag-workbench/graph/search', {
        query: trimmedQuery,
        project_space_id: selectedProjectSpaceId || undefined,
        limit,
      });
      setResults(data.results || []);
      setHasSearched(true);
    } catch (searchError) {
      console.error('Failed to search RAG graph:', searchError);
      setError(t('graphExplorer.loadFailed'));
    } finally {
      setIsSearching(false);
    }
  }, [isSearching, limit, query, selectedProjectSpaceId, t]);

  useEffect(() => {
    if (!initialQuery || hasAutoRunFromUrl.current) return;

    hasAutoRunFromUrl.current = true;
    void searchGraph(initialQuery);
  }, [initialQuery, searchGraph]);

  const entityCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const result of results) {
      for (const entity of result.metadata?.graph_entities || []) {
        counts.set(entity, (counts.get(entity) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16);
  }, [results]);

  const getSourceName = useCallback((result: GraphResult) => {
    const metadata = result.metadata;
    return stripMarkdownExtension(metadata?.filename || result.filename || metadata?.file_id || result.file_id || t('ragWorkbench.unknownSource'));
  }, [t]);

  return (
    <div className="flex h-full flex-col bg-bg-base text-text-main transition-colors duration-300">
      <div className="hidden items-center justify-between gap-4 border-b border-border bg-bg-sidebar p-4 md:flex">
        <div className="flex items-center gap-2">
          <GitFork className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">{t('graphExplorer.title')}</h1>
            <p className="text-sm text-text-muted">{t('graphExplorer.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-5">
          <div className="md:hidden">
            <h1 className="text-xl font-semibold">{t('graphExplorer.title')}</h1>
            <p className="mt-1 text-sm text-text-muted">{t('graphExplorer.subtitle')}</p>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <section className="rounded-lg border border-border bg-bg-sidebar p-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_120px_auto] lg:items-end">
              <label className="min-w-0">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('graphExplorer.queryLabel')}
                </span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void searchGraph();
                  }}
                  className="h-11 w-full rounded-lg border border-border bg-bg-base px-3 text-sm text-text-main outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                  placeholder={t('graphExplorer.queryPlaceholder')}
                />
              </label>

              <label>
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('usage.workspace')}
                </span>
                <select
                  value={selectedProjectSpaceId}
                  onChange={(event) => setSelectedProjectSpaceId(event.target.value)}
                  className="h-11 w-full rounded-lg border border-border bg-bg-base px-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">{t('ragEval.allWorkspaces')}</option>
                  {projectSpaces.map((space) => (
                    <option key={space.id} value={space.id}>{space.name}</option>
                  ))}
                </select>
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
                  className="h-11 w-full rounded-lg border border-border bg-bg-base px-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>

              <button
                onClick={() => void searchGraph()}
                disabled={!query.trim() || isSearching}
                className="flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {isSearching ? t('common.loading') : t('graphExplorer.search')}
              </button>
            </div>
          </section>

          {isSearching && !hasSearched ? (
            <div className="grid gap-3 lg:grid-cols-3">
              <Skeleton className="h-32 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
            </div>
          ) : hasSearched ? (
            <section className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
              <aside className="rounded-lg border border-border bg-bg-sidebar p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Network className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">{t('graphExplorer.entities')}</h2>
                </div>
                {entityCounts.length === 0 ? (
                  <p className="text-sm text-text-muted">{t('graphExplorer.emptyEntities')}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {entityCounts.map(([entity, count]) => (
                      <span key={entity} className="rounded border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-primary">
                        {entity} · {count}
                      </span>
                    ))}
                  </div>
                )}
              </aside>

              <div className="rounded-lg border border-border bg-bg-sidebar">
                <div className="flex items-center justify-between gap-3 border-b border-border p-4">
                  <div>
                    <h2 className="font-semibold">{t('graphExplorer.results')}</h2>
                    <p className="text-xs text-text-muted">{t('graphExplorer.resultCount', { count: results.length })}</p>
                  </div>
                </div>

                {results.length === 0 ? (
                  <div className="p-6 text-sm text-text-muted">{t('graphExplorer.emptyResults')}</div>
                ) : (
                  <div className="divide-y divide-border">
                    {results.map((result, index) => {
                      const metadata = result.metadata || {};
                      const entities = metadata.graph_entities || [];

                      return (
                        <article key={result.id || result.chunk_id || `${getSourceName(result)}-${index}`} className="p-4">
                          <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold">{getSourceName(result)}</p>
                              <p className="mt-1 text-xs text-text-muted">
                                {metadata.chunk_index !== undefined && metadata.chunk_index !== null ? `#${metadata.chunk_index} · ` : ''}
                                {metadata.retrieval_mode || 'graph'}
                              </p>
                            </div>
                            <span className="shrink-0 rounded border border-border bg-bg-base px-2 py-1 text-xs text-text-muted">
                              {t('graphExplorer.score')}: {formatDecimal(result.score)}
                            </span>
                          </div>

                          <p className="max-h-32 overflow-hidden whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-base p-3 text-sm leading-6 text-text-muted">
                            {result.content || t('usage.notAvailable')}
                          </p>

                          <div className="mt-3 flex flex-wrap gap-2">
                            {entities.length === 0 ? (
                              <span className="text-xs text-text-muted">{t('graphExplorer.emptyEntities')}</span>
                            ) : entities.map((entity) => (
                              <span key={`${result.id || index}-${entity}`} className="rounded border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] text-primary">
                                {entity}
                              </span>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-sidebar p-8 text-center">
              <GitFork className="mb-3 h-10 w-10 text-primary" />
              <p className="text-sm text-text-muted">{t('graphExplorer.emptyState')}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentToolDiagnosticHistoryPage,
  AgentToolDiagnosticHistoryQuery,
  AgentToolDiagnosticHistoryEntry,
  AgentToolDiagnosticOperation,
} from './types';

interface AgentToolDiagnosticHistoryProps {
  toolId: string;
  currentVersionId: string;
  revision: number;
  onList(
    id: string,
    query: AgentToolDiagnosticHistoryQuery,
  ): Promise<AgentToolDiagnosticHistoryPage>;
}

type OperationFilter = AgentToolDiagnosticOperation | 'all';

const operationFilters: OperationFilter[] = ['all', 'preflight', 'safe_test', 'discover'];

const historyKey = (entry: AgentToolDiagnosticHistoryEntry) => entry.id;

export default function AgentToolDiagnosticHistory(
  props: AgentToolDiagnosticHistoryProps,
) {
  const { t } = useTranslation();
  const {
    toolId,
    currentVersionId,
    revision,
    onList,
  } = props;
  const [operation, setOperation] = useState<OperationFilter>('all');
  const [items, setItems] = useState<AgentToolDiagnosticHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    void onList(toolId, {
      limit: 10,
      ...(operation !== 'all' ? { operation } : {}),
    }).then((page) => {
      if (!active) return;
      setItems(page.items);
      setNextCursor(page.next_cursor);
    }).catch(() => {
      if (!active) return;
      setItems([]);
      setNextCursor(null);
      setFailed(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [currentVersionId, onList, operation, revision, toolId]);

  const currentVersionItems = useMemo(
    () => items.filter((entry) => entry.tool_version_id === currentVersionId),
    [currentVersionId, items],
  );
  const currentVersionPassRate = currentVersionItems.length > 0
    ? Math.round(
      (currentVersionItems.filter((entry) => entry.status === 'passed').length
        / currentVersionItems.length) * 100,
    )
    : null;

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setFailed(false);
    try {
      const page = await onList(toolId, {
        limit: 10,
        cursor: nextCursor,
        ...(operation !== 'all' ? { operation } : {}),
      });
      setItems((current) => {
        const known = new Set(current.map(historyKey));
        return [...current, ...page.items.filter((entry) => !known.has(entry.id))];
      });
      setNextCursor(page.next_cursor);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-sky-500/15 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-text-main">
            <Activity className="h-3.5 w-3.5 text-sky-300" />
            {t('agents.toolHealthHistory')}
          </div>
          <p className="mt-1 text-xs leading-5 text-text-muted">
            {t('agents.toolHealthHistoryHint')}
          </p>
        </div>
        {currentVersionPassRate !== null ? (
          <span className="rounded-full border border-border bg-bg-base px-2.5 py-1 text-xs text-text-muted">
            {t('agents.currentVersionPassRate', {
              rate: currentVersionPassRate,
              count: currentVersionItems.length,
            })}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {operationFilters.map((filter) => (
          <button
            key={filter}
            type="button"
            onClick={() => setOperation(filter)}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${operation === filter
              ? 'border-sky-500/50 bg-sky-500/10 text-sky-100'
              : 'border-border text-text-muted hover:text-text-main'}`}
          >
            {filter === 'all' ? t('agents.allDiagnostics') : filter}
          </button>
        ))}
      </div>

      {loading ? <p className="text-xs text-text-muted">{t('common.loading')}</p> : null}
      {!loading && items.length === 0 && !failed ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
          {t('agents.healthHistoryEmpty')}
        </p>
      ) : null}
      {failed ? (
        <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-200">
          {t('agents.healthHistoryUnavailable')}
        </p>
      ) : null}

      <div className="space-y-2">
        {items.map((entry) => {
          const currentVersion = entry.tool_version_id === currentVersionId;
          return (
            <div key={entry.id} className="rounded-lg border border-border bg-bg-base/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  {entry.status === 'passed' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                  ) : (
                    <TriangleAlert className="h-3.5 w-3.5 text-red-300" />
                  )}
                  <span className={entry.status === 'passed' ? 'text-emerald-200' : 'text-red-200'}>
                    {entry.operation}
                  </span>
                  <span className="text-text-muted">{entry.duration_ms} ms</span>
                  <span className={currentVersion ? 'text-sky-200' : 'text-text-muted'}>
                    {currentVersion ? t('agents.currentToolVersion') : t('agents.previousToolVersion')}
                  </span>
                </div>
                <time className="text-text-muted" dateTime={entry.checked_at}>
                  {new Date(entry.checked_at).toLocaleString()}
                </time>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
                <span>{t('agents.healthCheckCounts', {
                  passed: entry.passed_check_count,
                  warnings: entry.warning_check_count,
                  failed: entry.failed_check_count,
                })}</span>
                <span>{entry.live_request_attempted
                  ? t('agents.liveRequestAttempted')
                  : t('agents.noLiveRequest')}</span>
                {entry.response_status ? <span>HTTP {entry.response_status}</span> : null}
                {entry.discovery_tool_count !== null
                  ? <span>{entry.discovery_tool_count} MCP tools</span>
                  : null}
                {entry.error_code ? <span className="font-mono text-red-200">{entry.error_code}</span> : null}
              </div>
            </div>
          );
        })}
      </div>

      {nextCursor ? (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          className="rounded-lg border border-border px-3 py-2 text-xs text-text-main hover:bg-bg-surface disabled:opacity-50"
        >
          {loadingMore ? t('common.loading') : t('agents.loadMoreHealthHistory')}
        </button>
      ) : null}
    </div>
  );
}

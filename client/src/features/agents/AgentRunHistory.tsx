import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleX, Clock3, Loader2, RefreshCw, ShieldAlert, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import api from '../../lib/api';
import { isRequestCancellation } from '../../lib/requestCancellation';
import { toSafeError } from '../../lib/safeError';
import AgentRunTimeline from './AgentRunTimeline';
import { buildPersistedAgentEvents } from './agentRunEvents';
import type { AgentRun, AgentRunDetail, AgentRunStatus } from './types';

interface AgentRunHistoryProps {
  agentId?: string | null;
}

const activeStatuses: AgentRunStatus[] = ['queued', 'running', 'waiting_approval'];

const statusIcons: Record<AgentRunStatus, typeof Loader2> = {
  queued: Clock3,
  running: Loader2,
  waiting_approval: ShieldAlert,
  succeeded: CircleCheck,
  failed: CircleX,
  cancelled: X,
};

const formatDate = (value?: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

export default function AgentRunHistory({ agentId }: AgentRunHistoryProps) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await api.get<AgentRun[]>('/agent-runs', {
        params: agentId ? { agentId, limit: 100 } : { limit: 100 },
        signal,
      });
      setRuns(response.data);
      setSelectedRunId((current) => {
        if (current && response.data.some((run) => run.id === current)) return current;
        return response.data[0]?.id || null;
      });
    } catch (error) {
      if (!isRequestCancellation(error)) {
        console.error('Failed to load Agent runs:', toSafeError(error));
        toast.error(t('agents.runsLoadFailed'));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [agentId, t]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    void loadRuns(controller.signal);
    return () => controller.abort();
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setLoadingDetail(true);
    void api.get<AgentRunDetail>(`/agent-runs/${selectedRunId}`, {
      params: { stepLimit: 500, approvalLimit: 200 },
      signal: controller.signal,
    }).then((response) => {
      setDetail(response.data);
    }).catch((error) => {
      if (!isRequestCancellation(error)) {
        console.error('Failed to load Agent run:', toSafeError(error));
        toast.error(t('agents.runDetailLoadFailed'));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingDetail(false);
    });
    return () => controller.abort();
  }, [selectedRunId, t]);

  const detailEvents = useMemo(() => detail
    ? buildPersistedAgentEvents({
      runId: detail.id,
      status: detail.status,
      steps: detail.steps,
      approvals: detail.approvals,
      grounding: detail.grounding,
    })
    : [], [detail]);

  const cancel = async () => {
    if (!detail || !activeStatuses.includes(detail.status)) return;
    setCancelling(true);
    try {
      const response = await api.post<AgentRun>(`/agent-runs/${detail.id}/cancel`);
      setRuns((current) => current.map((run) => run.id === response.data.id ? response.data : run));
      setDetail((current) => current ? {
        ...current,
        ...response.data,
        steps: current.steps.map((step) => (
          ['pending', 'running'].includes(step.status)
            ? { ...step, status: 'cancelled' as const, output: step.output || { reason: response.data.error_message || 'Agent run cancelled' } }
            : step
        )),
        approvals: current.approvals.map((approval) => (
          approval.status === 'pending'
            ? { ...approval, status: 'expired' as const, reason: response.data.error_message || 'Agent run cancelled' }
            : approval
        )),
      } : current);
      toast.success(t('agents.runCancelled'));
    } catch (error) {
      console.error('Failed to cancel Agent run:', toSafeError(error));
      toast.error(t('agents.runCancelFailed'));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="grid min-h-[520px] gap-4 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
      <section className="rounded-xl border border-border bg-bg-base p-3">
        <div className="mb-3 flex items-center justify-between gap-2 px-1">
          <div>
            <h2 className="text-sm font-semibold text-text-main">{t('agents.runHistory')}</h2>
            <p className="text-xs text-text-muted">{agentId ? t('agents.filteredRunHistory') : t('agents.allRunHistory')}</p>
          </div>
          <button
            type="button"
            onClick={() => void loadRuns()}
            disabled={loading}
            className="rounded-lg border border-border p-2 text-text-muted hover:text-text-main disabled:opacity-50"
            aria-label={t('agents.refreshRuns')}
            title={t('agents.refreshRuns')}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {loading ? <p className="px-2 py-8 text-center text-sm text-text-muted">{t('common.loading')}</p> : null}
        {!loading && runs.length === 0 ? <p className="px-2 py-8 text-center text-sm text-text-muted">{t('agents.noRuns')}</p> : null}
        <div className="space-y-2">
          {runs.map((run) => {
            const Icon = statusIcons[run.status];
            const snapshotVersion = typeof run.agent_version_snapshot?.version === 'number'
              ? run.agent_version_snapshot.version
              : null;
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                className={`w-full rounded-xl border p-3 text-left transition-colors ${selectedRunId === run.id ? 'border-primary/60 bg-primary/10' : 'border-border bg-bg-sidebar hover:border-primary/30'}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-main">
                    <Icon className={`h-4 w-4 shrink-0 ${run.status === 'running' ? 'animate-spin' : ''}`} />
                    <span className="truncate">{t(`agents.runStatuses.${run.status}`)}</span>
                  </span>
                  <span className="font-mono text-[10px] text-text-muted">{run.id.slice(0, 8)}</span>
                </span>
                <span className="mt-2 block text-xs text-text-muted">{formatDate(run.created_at)}</span>
                <span className="mt-1 block text-[10px] text-text-muted">
                  {snapshotVersion ? `v${snapshotVersion}` : '—'} · {run.iteration_count} {t('agents.iterations')} · {run.tool_call_count} {t('agents.toolCalls')}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-bg-sidebar p-4 md:p-6">
        {loadingDetail ? <p className="text-sm text-text-muted">{t('common.loading')}</p> : null}
        {!loadingDetail && detail ? (
          <>
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
              <div>
                <h2 className="text-lg font-semibold text-text-main">{t('agents.runDetails')}</h2>
                <p className="mt-1 font-mono text-xs text-text-muted">{detail.id}</p>
                <p className="mt-1 text-xs text-text-muted">{formatDate(detail.created_at)} · {t(`agents.runStatuses.${detail.status}`)}</p>
                {detail.grounding ? (
                  <p className="mt-1 text-xs text-text-muted">
                    {t('agents.groundingStatus', {
                      status: t(`agents.groundingStatuses.${detail.grounding.status}`, {
                        defaultValue: detail.grounding.status,
                      }),
                      score: Math.round(detail.grounding.score * 100),
                    })}
                  </p>
                ) : null}
              </div>
              {activeStatuses.includes(detail.status) ? (
                <button
                  type="button"
                  onClick={() => void cancel()}
                  disabled={cancelling}
                  className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                >
                  <Square className="h-3.5 w-3.5" />
                  {cancelling ? t('common.saving') : t('agents.cancelRun')}
                </button>
              ) : null}
            </header>
            {detail.error_message ? (
              <p className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-300">{detail.error_message}</p>
            ) : null}
            <div className="mt-4 grid gap-3 text-xs text-text-muted sm:grid-cols-3">
              <span>{t('agents.startedAt')}: {formatDate(detail.started_at)}</span>
              <span>{t('agents.completedAt')}: {formatDate(detail.completed_at)}</span>
              <span>{t('agents.iterations')}: {detail.iteration_count} · {t('agents.toolCalls')}: {detail.tool_call_count}</span>
            </div>
            <div className="mt-4">
              <AgentRunTimeline runId={detail.id} events={detailEvents} active={activeStatuses.includes(detail.status)} />
            </div>
          </>
        ) : null}
        {!loadingDetail && !detail ? (
          <div className="grid min-h-[420px] place-items-center text-center">
            <div>
              <Clock3 className="mx-auto h-10 w-10 text-primary" />
              <h2 className="mt-4 text-lg font-semibold text-text-main">{t('agents.selectRunTitle')}</h2>
              <p className="mt-2 text-sm text-text-muted">{t('agents.selectRunHint')}</p>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

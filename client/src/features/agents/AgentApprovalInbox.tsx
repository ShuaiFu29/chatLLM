import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import api from '../../lib/api';
import { isRequestCancellation } from '../../lib/requestCancellation';
import { toSafeError } from '../../lib/safeError';
import type {
  AgentApprovalInboxItem,
  AgentApprovalInboxResponse,
} from './types';
import { redactAgentApprovalArguments } from './agentRunEvents';

const POLL_INTERVAL_MS = 5_000;

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

export default function AgentApprovalInbox() {
  const { t } = useTranslation();
  const [items, setItems] = useState<AgentApprovalInboxItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const load = useCallback(async (input: {
    cursor?: string | null;
    append?: boolean;
    silent?: boolean;
    signal?: AbortSignal;
  } = {}) => {
    if (!input.silent) {
      if (input.append) setLoadingMore(true);
      else setLoading(true);
    }
    try {
      const response = await api.get<AgentApprovalInboxResponse>('/agent-runs/approvals/inbox', {
        params: {
          status: 'pending',
          limit: 20,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        signal: input.signal,
      });
      setItems((current) => input.append
        ? [...current, ...response.data.items.filter(
          (item) => !current.some((existing) => existing.id === item.id),
        )]
        : response.data.items);
      setNextCursor(response.data.next_cursor);
    } catch (error) {
      if (!isRequestCancellation(error)) {
        console.error('Failed to load Agent approvals:', toSafeError(error));
        if (!input.silent) toast.error(t('agents.approvalInboxLoadFailed'));
      }
    } finally {
      if (!input.silent && !input.signal?.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    void load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await load({ silent: true, signal: controller.signal });
      if (!stopped) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  const decide = async (item: AgentApprovalInboxItem, decision: 'approved' | 'rejected') => {
    setDecidingId(item.id);
    try {
      await api.post(`/agent-runs/${item.run_id}/approvals/${item.id}`, { decision });
      setItems((current) => current.filter((approval) => approval.id !== item.id));
      toast.success(t(decision === 'approved' ? 'chat.approvalApproved' : 'chat.approvalRejected'));
    } catch {
      toast.error(t('chat.approvalFailed'));
      await load({ silent: true });
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <section className="min-h-[640px] rounded-xl border border-border bg-bg-sidebar p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text-main">
            <ShieldCheck className="h-5 w-5 text-amber-300" />
            {t('agents.approvalInboxTitle')}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
            {t('agents.approvalInboxHint')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-main hover:border-primary/50 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {t('common.refresh')}
        </button>
      </header>

      {loading ? (
        <div className="grid min-h-80 place-items-center text-text-muted">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="grid min-h-80 place-items-center text-center">
          <div className="max-w-md">
            <ShieldCheck className="mx-auto h-10 w-10 text-emerald-400" />
            <h3 className="mt-4 font-medium text-text-main">{t('agents.approvalInboxEmpty')}</h3>
            <p className="mt-2 text-sm leading-6 text-text-muted">{t('agents.approvalInboxEmptyHint')}</p>
          </div>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {items.map((item) => (
            <article key={item.id} className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded border border-amber-500/30 px-2 py-0.5 text-xs text-amber-300">
                      {t(`agents.riskLevels.${item.intent.risk_level}`)}
                    </span>
                    <code className="break-all text-xs text-text-main">{item.intent.tool_key}</code>
                    <span className="text-xs uppercase text-text-muted">{item.intent.tool_kind}</span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-text-main">{item.intent.side_effect_summary}</p>
                </div>
                <span className="text-xs text-text-muted">
                  {t('chat.approvalExpires', { time: formatDate(item.expires_at) })}
                </span>
              </div>

              {item.requested_by_run_id && (
                <p className="mt-3 flex items-center gap-2 text-xs text-amber-100/80">
                  <GitBranch className="h-3.5 w-3.5" />
                  {t('chat.approvalRequestedBySubagent', {
                    name: item.requesting_agent_name || t('chat.unknownSubagent'),
                    depth: item.requesting_depth,
                  })}
                </p>
              )}

              <dl className="mt-4 grid gap-x-4 gap-y-2 rounded-lg border border-border/70 bg-bg-base/70 p-3 text-xs sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt className="text-text-muted">{t('agents.approvalTarget')}</dt>
                <dd className="break-all font-mono text-text-main">{item.intent.target || t('agents.approvalInternalTarget')}</dd>
                <dt className="text-text-muted">{t('agents.approvalMethod')}</dt>
                <dd className="break-all font-mono text-text-main">{item.intent.method}</dd>
                <dt className="text-text-muted">{t('agents.approvalPolicyChain')}</dt>
                <dd className="font-mono text-text-main">{item.intent.policy_chain.join(' → ')}</dd>
                {item.intent.tool_version_id && (
                  <>
                    <dt className="text-text-muted">{t('agents.approvalToolVersion')}</dt>
                    <dd className="break-all font-mono text-text-main">
                      {item.intent.tool_version_id}
                      {item.intent.secret_version ? ` · secret v${item.intent.secret_version}` : ''}
                    </dd>
                  </>
                )}
                {item.intent.configuration_hash && (
                  <>
                    <dt className="text-text-muted">{t('agents.approvalConfigurationHash')}</dt>
                    <dd className="break-all font-mono text-text-muted">{item.intent.configuration_hash}</dd>
                  </>
                )}
                <dt className="text-text-muted">{t('agents.approvalInputHash')}</dt>
                <dd className="break-all font-mono text-text-muted">{item.intent.input_hash}</dd>
                <dt className="text-text-muted">{t('agents.approvalRun')}</dt>
                <dd className="font-mono text-text-muted">{item.run_id}</dd>
              </dl>

              {item.input !== undefined && (
                <details className="mt-3 rounded-lg border border-border/60 bg-bg-base/50 p-3">
                  <summary className="cursor-pointer text-xs text-text-muted">{t('agents.approvalArguments')}</summary>
                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-text-muted">
                    {JSON.stringify(redactAgentApprovalArguments(item.input), null, 2)}
                  </pre>
                </details>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void decide(item, 'approved')}
                  disabled={decidingId === item.id}
                  className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {t('chat.approveTool')}
                </button>
                <button
                  type="button"
                  onClick={() => void decide(item, 'rejected')}
                  disabled={decidingId === item.id}
                  className="rounded-lg border border-red-500/30 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                >
                  {t('chat.rejectTool')}
                </button>
              </div>
            </article>
          ))}
          {nextCursor && (
            <button
              type="button"
              onClick={() => void load({ cursor: nextCursor, append: true })}
              disabled={loadingMore}
              className="w-full rounded-lg border border-border px-3 py-2 text-sm text-text-main hover:border-primary/50 disabled:opacity-50"
            >
              {loadingMore ? t('common.loading') : t('agents.approvalLoadMore')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FlaskConical,
  LoaderCircle,
  Play,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import api from '../../lib/api';
import { readApiErrorMessage } from '../../lib/apiError';
import { isRequestCancellation } from '../../lib/requestCancellation';
import type { AgentVersionDryRun } from './types';

interface AgentVersionDryRunPanelProps {
  agentId: string;
  versionId: string;
  versionNumber: number | string;
}

const statusClasses = {
  running: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  succeeded: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  failed: 'border-red-500/30 bg-red-500/10 text-red-200',
} as const;

export default function AgentVersionDryRunPanel({
  agentId,
  versionId,
  versionNumber,
}: AgentVersionDryRunPanelProps) {
  const { t, i18n } = useTranslation();
  const [input, setInput] = useState('');
  const [runs, setRuns] = useState<AgentVersionDryRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState('');
  const loadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setLoadError('');
    void api.get<AgentVersionDryRun[]>(
      `/agents/${agentId}/versions/${versionId}/dry-runs`,
      { params: { limit: 10 }, signal: controller.signal },
    ).then((response) => {
      setRuns(response.data);
    }).catch((error: unknown) => {
      if (!isRequestCancellation(error)) {
        setLoadError(readApiErrorMessage(error, t('agents.dryRunHistoryLoadFailed')));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [agentId, t, versionId]);

  const execute = async () => {
    const requestInput = input.trim();
    if (!requestInput || running) return;
    setRunning(true);
    try {
      const { data } = await api.post<AgentVersionDryRun>(
        `/agents/${agentId}/versions/${versionId}/dry-runs`,
        { input: requestInput },
      );
      setRuns((current) => [data, ...current.filter((run) => run.id !== data.id)].slice(0, 10));
      if (data.status === 'succeeded') {
        toast.success(t('agents.dryRunSucceeded'));
      } else {
        toast.error(data.failure_message || t('agents.dryRunFailed'));
      }
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.dryRunFailed')));
    } finally {
      setRunning(false);
    }
  };

  const formatDate = (value: string) => new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

  return (
    <section className="space-y-4 rounded-xl border border-border bg-bg-base p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <FlaskConical className="h-4 w-4 text-primary" />
            {t('agents.dryRunTitle', { version: versionNumber })}
          </h4>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-text-muted">{t('agents.dryRunHint')}</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
          <ShieldCheck className="h-3.5 w-3.5" /> {t('agents.dryRunModelOnly')}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-text-muted">{t('agents.dryRunInput')}</span>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={4}
            maxLength={16000}
            placeholder={t('agents.dryRunPlaceholder')}
            className="w-full resize-y rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm leading-6 text-text-main outline-none transition focus:border-primary/60"
          />
        </label>
        <button
          type="button"
          disabled={running || !input.trim()}
          onClick={() => void execute()}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? t('agents.dryRunRunning') : t('agents.runDryRun')}
        </button>
      </div>

      <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-100">
        {t('agents.dryRunIsolationNotice')}
      </p>

      {loadError ? (
        <p className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <AlertCircle className="h-4 w-4 shrink-0" /> {loadError}
        </p>
      ) : null}
      {loading ? (
        <p className="flex items-center justify-center gap-2 py-6 text-sm text-text-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" /> {t('common.loading')}
        </p>
      ) : null}
      {!loading && runs.length === 0 ? (
        <p className="py-4 text-center text-xs text-text-muted">{t('agents.noDryRuns')}</p>
      ) : null}
      {!loading && runs.length > 0 ? (
        <div className="space-y-3">
          {runs.map((run) => {
            const failedChecks = run.validation_report.checks.filter((check) => check.status === 'failed');
            return (
              <article
                key={run.id}
                style={{ contentVisibility: 'auto', containIntrinsicSize: '0 180px' }}
                className="rounded-xl border border-border bg-bg-surface p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded border px-2 py-0.5 text-[10px] ${statusClasses[run.status]}`}>
                      {t(`agents.dryRunStatuses.${run.status}`)}
                    </span>
                    <span className="text-[11px] text-text-muted">{formatDate(run.created_at)}</span>
                  </div>
                  <span className="text-[11px] text-text-muted">
                    {t('agents.dryRunUsage', { tokens: run.usage.total_tokens, tools: run.planned_tool_calls.length })}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-text-muted">{run.input_text}</p>
                {run.output_text ? (
                  <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-base p-3 text-xs leading-5 text-text-main">
                    {run.output_text}
                  </pre>
                ) : null}
                {run.failure_message ? (
                  <p className="mt-3 flex items-center gap-2 text-xs text-red-200">
                    <AlertCircle className="h-4 w-4 shrink-0" /> {run.failure_message}
                  </p>
                ) : null}
                {failedChecks.length > 0 ? (
                  <div className="mt-3 space-y-1 rounded-lg border border-red-500/20 bg-red-500/5 p-2">
                    {failedChecks.map((check) => (
                      <p key={check.key} className="text-[11px] leading-5 text-red-100">
                        {check.key}: {check.message}
                      </p>
                    ))}
                  </div>
                ) : null}
                {run.planned_tool_calls.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    <p className="flex items-center gap-1 text-[11px] font-medium text-text-muted">
                      <Wrench className="h-3.5 w-3.5" /> {t('agents.dryRunToolPlans')}
                    </p>
                    {run.planned_tool_calls.map((call) => (
                      <div key={call.tool_call_id} className="rounded-lg border border-border bg-bg-base px-3 py-2 text-[11px]">
                        <div className="flex flex-wrap items-center gap-2">
                          {call.status === 'simulated'
                            ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                            : <AlertCircle className="h-3.5 w-3.5 text-red-300" />}
                          <code className="text-text-main">{call.tool_key}</code>
                          <span className="text-text-muted">{call.risk_level} · {call.policy_decision}</span>
                        </div>
                        {call.validation_error ? <p className="mt-1 text-red-200">{call.validation_error}</p> : null}
                        {call.arguments ? (
                          <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-text-muted">{JSON.stringify(call.arguments, null, 2)}</pre>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

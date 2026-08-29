import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  GitCompareArrows,
  History,
  LoaderCircle,
  MinusCircle,
  RotateCcw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import SelectField from '../../components/SelectField';
import api from '../../lib/api';
import { readApiErrorMessage } from '../../lib/apiError';
import { isRequestCancellation } from '../../lib/requestCancellation';
import type {
  Agent,
  AgentPublicationValidationReport,
  AgentVersion,
  AgentVersionDiff,
} from './types';
import AgentVersionDryRunPanel from './AgentVersionDryRunPanel';
import AgentVersionEvalPanel from './AgentVersionEvalPanel';

interface AgentVersionHistoryProps {
  agent: Agent;
  onRollback(agentId: string, versionId: string): Promise<Agent>;
  onSelected(agent: Agent): void;
}

const statusStyle = {
  passed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  failed: 'border-red-500/30 bg-red-500/10 text-red-200',
  not_applicable: 'border-border bg-bg-surface text-text-muted',
} as const;

const initialBaseVersionId = (agent: Agent) => {
  if (agent.published_version_id && agent.published_version_id !== agent.current_version_id) {
    return agent.published_version_id;
  }
  return agent.derived_from_version_id || '';
};

const formatDiffValue = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, null, 2);
};

const validationCounts = (report: AgentPublicationValidationReport) => report.checks.reduce(
  (counts, check) => ({ ...counts, [check.status]: counts[check.status] + 1 }),
  { passed: 0, failed: 0, not_applicable: 0 },
);

export default function AgentVersionHistory({
  agent,
  onRollback,
  onSelected,
}: AgentVersionHistoryProps) {
  const { t, i18n } = useTranslation();
  const defaultBaseId = initialBaseVersionId(agent);
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [targetVersionId, setTargetVersionId] = useState(agent.current_version_id);
  const [baseVersionId, setBaseVersionId] = useState(defaultBaseId);
  const [diff, setDiff] = useState<AgentVersionDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(Boolean(defaultBaseId));
  const [loadError, setLoadError] = useState('');
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setLoading(true);
    setDiffLoading(Boolean(defaultBaseId));
    setLoadError('');

    const historyRequest = api.get<AgentVersion[]>(`/agents/${agent.id}/versions`, {
      signal: controller.signal,
    });
    const diffRequest = defaultBaseId
      ? api.get<AgentVersionDiff>(`/agents/${agent.id}/versions/${agent.current_version_id}/diff`, {
        params: { againstVersionId: defaultBaseId },
        signal: controller.signal,
      })
      : Promise.resolve(undefined);

    void Promise.all([historyRequest, diffRequest])
      .then(([historyResponse, diffResponse]) => {
        setVersions(historyResponse.data);
        setDiff(diffResponse?.data || null);
      })
      .catch((error: unknown) => {
        if (!isRequestCancellation(error)) {
          setLoadError(readApiErrorMessage(error, t('agents.versionHistoryLoadFailed')));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setDiffLoading(false);
        }
      });

    return () => {
      controller.abort();
      requestAbortRef.current?.abort();
    };
  }, [agent.current_version_id, agent.id, defaultBaseId, t]);

  const versionNumberById = useMemo(
    () => new Map(versions.map((version) => [version.id, version.version])),
    [versions],
  );

  const requestDiff = async (targetId: string, baseId: string) => {
    requestAbortRef.current?.abort();
    if (!targetId || !baseId || targetId === baseId) {
      setDiff(null);
      setDiffLoading(false);
      return;
    }
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setDiffLoading(true);
    setLoadError('');
    try {
      const response = await api.get<AgentVersionDiff>(
        `/agents/${agent.id}/versions/${targetId}/diff`,
        { params: { againstVersionId: baseId }, signal: controller.signal },
      );
      setDiff(response.data);
    } catch (error) {
      if (!isRequestCancellation(error)) {
        setLoadError(readApiErrorMessage(error, t('agents.versionDiffLoadFailed')));
      }
    } finally {
      if (!controller.signal.aborted) setDiffLoading(false);
    }
  };

  const selectTarget = (versionId: string) => {
    const nextBaseId = baseVersionId === versionId
      ? versions.find((version) => version.id !== versionId)?.id || ''
      : baseVersionId;
    setTargetVersionId(versionId);
    setBaseVersionId(nextBaseId);
    void requestDiff(versionId, nextBaseId);
  };

  const selectBase = (versionId: string) => {
    setBaseVersionId(versionId);
    void requestDiff(targetVersionId, versionId);
  };

  const rollback = async (version: AgentVersion) => {
    if (!window.confirm(t('agents.rollbackConfirm', { version: version.version }))) return;
    setRollingBackId(version.id);
    try {
      const rolledBack = await onRollback(agent.id, version.id);
      onSelected(rolledBack);
      toast.success(t('agents.rollbackSucceeded', { version: rolledBack.version }));
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.rollbackFailed')));
    } finally {
      setRollingBackId(null);
    }
  };

  const formatDate = (value: string) => new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

  return (
    <section className="space-y-4 rounded-xl border border-border bg-bg-base/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <History className="h-4 w-4 text-primary" /> {t('agents.versionHistory')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-text-muted">{t('agents.versionHistoryHint')}</p>
        </div>
        <div className="min-w-0 text-right text-[11px] text-text-muted">
          <p>{t('agents.configurationHash')}</p>
          <code className="block max-w-72 truncate text-text-main" title={agent.configuration_hash}>
            {agent.configuration_hash}
          </code>
        </div>
      </div>

      {loadError ? (
        <p className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <AlertCircle className="h-4 w-4 shrink-0" /> {loadError}
        </p>
      ) : null}

      {loading ? (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-text-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" /> {t('common.loading')}
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.15fr)]">
          <div className="max-h-[620px] space-y-2 overflow-y-auto pr-1">
            {versions.map((version) => {
              const counts = version.validation_report
                ? validationCounts(version.validation_report)
                : null;
              return (
                <article
                  key={version.id}
                  style={{ contentVisibility: 'auto', containIntrinsicSize: '0 148px' }}
                  className={`rounded-xl border p-3 ${targetVersionId === version.id ? 'border-primary/60 bg-primary/10' : 'border-border bg-bg-base'}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold text-text-main">v{version.version}</span>
                        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                          {t(`agents.versionKinds.${version.change_kind}`)}
                        </span>
                        {version.is_current ? <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{t('agents.currentVersion')}</span> : null}
                        {version.is_published ? <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-200">{t('agents.publishedVersion')}</span> : null}
                      </div>
                      <p className="mt-1 text-[11px] text-text-muted">{formatDate(version.created_at)}</p>
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => selectTarget(version.id)}
                        className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:border-primary/40 hover:text-text-main"
                      >
                        {t('agents.compare')}
                      </button>
                      {!version.is_current ? (
                        <button
                          type="button"
                          disabled={rollingBackId !== null}
                          onClick={() => void rollback(version)}
                          className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/10 disabled:opacity-50"
                        >
                          {rollingBackId === version.id
                            ? <LoaderCircle className="h-3 w-3 animate-spin" />
                            : <RotateCcw className="h-3 w-3" />}
                          {t('agents.rollbackToDraft')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <code className="mt-2 block truncate text-[10px] text-text-muted" title={version.configuration_hash}>
                    {version.configuration_hash}
                  </code>
                  {version.derived_from_version_id ? (
                    <p className="mt-1 text-[10px] text-text-muted">
                      {t('agents.derivedFrom', {
                        version: versionNumberById.get(version.derived_from_version_id) || '?',
                      })}
                    </p>
                  ) : null}
                  {version.published_at ? (
                    <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2">
                      <p className="text-[10px] text-emerald-200">
                        {t('agents.publishedAt', { date: formatDate(version.published_at) })}
                      </p>
                      {version.release_notes ? <p className="mt-1 text-xs leading-5 text-text-main">{version.release_notes}</p> : null}
                      {counts ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {(['passed', 'failed', 'not_applicable'] as const).map((status) => counts[status] > 0 ? (
                            <span key={status} className={`rounded border px-1.5 py-0.5 text-[10px] ${statusStyle[status]}`}>
                              {t(`agents.validationStatuses.${status}`)} {counts[status]}
                            </span>
                          ) : null)}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>

          <div className="min-w-0 rounded-xl border border-border bg-bg-base p-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-40 flex-1 space-y-1.5">
                <span className="text-[11px] font-medium text-text-muted">{t('agents.compareTarget')}</span>
                <SelectField value={targetVersionId} onChange={(event) => selectTarget(event.target.value)}>
                  {versions.map((version) => <option key={version.id} value={version.id}>v{version.version}</option>)}
                </SelectField>
              </label>
              <GitCompareArrows className="mb-2 h-4 w-4 text-text-muted" />
              <label className="min-w-40 flex-1 space-y-1.5">
                <span className="text-[11px] font-medium text-text-muted">{t('agents.compareBase')}</span>
                <SelectField value={baseVersionId} onChange={(event) => selectBase(event.target.value)}>
                  <option value="">{t('agents.selectVersion')}</option>
                  {versions.filter((version) => version.id !== targetVersionId).map((version) => (
                    <option key={version.id} value={version.id}>v{version.version}</option>
                  ))}
                </SelectField>
              </label>
            </div>

            {diffLoading ? (
              <p className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted">
                <LoaderCircle className="h-4 w-4 animate-spin" /> {t('agents.loadingDiff')}
              </p>
            ) : null}
            {!diffLoading && !baseVersionId ? (
              <p className="py-12 text-center text-sm text-text-muted">{t('agents.selectVersionToCompare')}</p>
            ) : null}
            {!diffLoading && diff && diff.changes.length === 0 ? (
              <p className="flex items-center justify-center gap-2 py-12 text-sm text-emerald-200">
                <CheckCircle2 className="h-4 w-4" /> {t('agents.noConfigurationChanges')}
              </p>
            ) : null}
            {!diffLoading && diff && diff.changes.length > 0 ? (
              <div className="mt-4 space-y-3">
                <p className="text-xs text-text-muted">
                  {t('agents.changedFieldCount', { count: diff.changes.length })}
                </p>
                {diff.changes.map((change) => (
                  <article key={change.field} className="overflow-hidden rounded-lg border border-border">
                    <h4 className="border-b border-border bg-bg-surface px-3 py-2 text-xs font-medium text-text-main">
                      {t(`agents.versionFields.${change.field}`, { defaultValue: change.field })}
                    </h4>
                    <div className="grid md:grid-cols-2">
                      <div className="min-w-0 border-b border-border p-3 md:border-b-0 md:border-r">
                        <p className="mb-2 flex items-center gap-1 text-[10px] uppercase tracking-wide text-red-300">
                          <MinusCircle className="h-3 w-3" /> {t('agents.before')}
                        </p>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-text-muted">{formatDiffValue(change.before)}</pre>
                      </div>
                      <div className="min-w-0 p-3">
                        <p className="mb-2 flex items-center gap-1 text-[10px] uppercase tracking-wide text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" /> {t('agents.after')}
                        </p>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-text-main">{formatDiffValue(change.after)}</pre>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
      {!loading && targetVersionId ? (
        <>
          <AgentVersionDryRunPanel
            agentId={agent.id}
            versionId={targetVersionId}
            versionNumber={versionNumberById.get(targetVersionId) || '?'}
          />
          <AgentVersionEvalPanel
            key={targetVersionId}
            agentId={agent.id}
            candidateVersionId={targetVersionId}
            versions={versions}
          />
        </>
      ) : null}
    </section>
  );
}

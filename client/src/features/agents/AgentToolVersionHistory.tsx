import { useEffect, useState } from 'react';
import { GitCompareArrows, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { isRequestCancellation } from '../../lib/requestCancellation';
import { toSafeError } from '../../lib/safeError';
import type {
  AgentToolVersion,
  AgentToolVersionDiff,
  CustomAgentTool,
} from './types';

interface AgentToolVersionHistoryProps {
  tool: CustomAgentTool;
}

const shortHash = (value: string | undefined) => value ? value.slice(0, 12) : '—';

export default function AgentToolVersionHistory({ tool }: AgentToolVersionHistoryProps) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<AgentToolVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [baseId, setBaseId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [diff, setDiff] = useState<AgentToolVersionDiff | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api.get<AgentToolVersion[]>(`/agent-tools/${tool.id}/versions`, {
      signal: controller.signal,
    }).then(({ data }) => {
      setVersions(data);
      setTargetId(data[0]?.id || '');
      setBaseId(data[1]?.id || data[0]?.id || '');
    }).catch((requestError: unknown) => {
      if (isRequestCancellation(requestError)) return;
      console.error('Failed to load Agent tool versions:', toSafeError(requestError));
      setError(t('agents.toolVersionLoadFailed'));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [t, tool.id, tool.tool_version_id]);

  useEffect(() => {
    if (!baseId || !targetId || baseId === targetId) {
      setDiff(null);
      return undefined;
    }
    const controller = new AbortController();
    void api.get<AgentToolVersionDiff>(`/agent-tools/${tool.id}/versions/${targetId}`, {
      params: { againstVersionId: baseId },
      signal: controller.signal,
    }).then(({ data }) => setDiff(data)).catch((requestError: unknown) => {
      if (isRequestCancellation(requestError)) return;
      console.error('Failed to compare Agent tool versions:', toSafeError(requestError));
      setDiff(null);
    });
    return () => controller.abort();
  }, [baseId, targetId, tool.id]);

  return (
    <section className="space-y-4 rounded-xl border border-border bg-bg-base/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <History className="h-4 w-4 text-primary" /> {t('agents.toolVersionHistory')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-text-muted">{t('agents.toolVersionHistoryHint')}</p>
        </div>
        <div className="text-right text-[11px] text-text-muted">
          <div>v{tool.tool_version ?? tool.latest_version ?? 1} · secret r{tool.secret_version ?? 1}</div>
          <code title={tool.configuration_hash}>{shortHash(tool.configuration_hash)}</code>
        </div>
      </div>

      {loading ? <p className="text-xs text-text-muted">{t('common.loading')}</p> : null}
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      {!loading && !error ? (
        <div className="space-y-2">
          {versions.map((version) => (
            <div key={version.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg-base px-3 py-2">
              <div className="text-xs text-text-main">
                <span className="font-medium">v{version.version}</span>
                <span className="ml-2 text-text-muted">{version.change_kind} · secret r{version.secret_version}</span>
                {version.is_current ? (
                  <span className="ml-2 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">current</span>
                ) : null}
              </div>
              <code className="text-[10px] text-text-muted" title={version.configuration_hash}>{shortHash(version.configuration_hash)}</code>
            </div>
          ))}
        </div>
      ) : null}

      {versions.length > 1 ? (
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-xs font-medium text-text-main">
            <GitCompareArrows className="h-4 w-4" /> {t('agents.compareToolVersions')}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <select className="rounded-lg border border-border bg-bg-base px-3 py-2 text-xs text-text-main" value={baseId} onChange={(event) => setBaseId(event.target.value)}>
              {versions.map((version) => <option key={version.id} value={version.id}>v{version.version}</option>)}
            </select>
            <select className="rounded-lg border border-border bg-bg-base px-3 py-2 text-xs text-text-main" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {versions.map((version) => <option key={version.id} value={version.id}>v{version.version}</option>)}
            </select>
          </div>
          {baseId === targetId ? <p className="text-xs text-text-muted">{t('agents.selectDifferentVersions')}</p> : null}
          {diff ? (
            <div className="space-y-2">
              {diff.changes.length === 0 ? <p className="text-xs text-text-muted">{t('agents.noVersionChanges')}</p> : null}
              {diff.changes.map((change) => (
                <details key={change.field} className="rounded-lg border border-border bg-bg-base px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-text-main">{change.field}</summary>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded bg-black/15 p-2 text-[10px] text-text-muted">{JSON.stringify(change.before, null, 2)}</pre>
                    <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded bg-black/15 p-2 text-[10px] text-text-muted">{JSON.stringify(change.after, null, 2)}</pre>
                  </div>
                </details>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

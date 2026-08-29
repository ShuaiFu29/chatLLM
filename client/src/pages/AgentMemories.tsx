import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Brain,
  Check,
  Eye,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { readApiErrorMessage } from '../lib/apiError';
import SelectField from '../components/SelectField';
import { useNavigate } from '../lib/navigation';

type MemoryScope = 'user' | 'project' | 'agent';
type MemoryTrust = 'user_stated' | 'agent_inferred' | 'tool_derived';
type MemoryStatus = 'candidate' | 'confirmed' | 'rejected';

interface AgentMemory {
  id: string;
  scope: MemoryScope;
  scope_ref_id: string | null;
  kind: 'fact' | 'preference' | 'decision' | 'summary';
  content: string;
  source_trust: MemoryTrust;
  status: MemoryStatus;
  verification_status: string;
  verified_at: string | null;
  confidence: number;
  sensitivity: 'normal' | 'personal' | 'sensitive' | 'restricted';
  last_recalled_at: string | null;
  recall_count: number;
  provenance_run_id: string | null;
  provenance_agent_id: string | null;
  scope_ref_name: string | null;
  superseded_by: string | null;
  expires_at: string | null;
  has_embedding: boolean;
  /** Whether recall would still return this row. Decided by the server. */
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface MemoryGovernance {
  memory: AgentMemory;
  evidence: Array<{
    id: string;
    evidence_kind: string;
    source_run_id: string | null;
    created_at: string;
  }>;
  events: Array<{
    id: string | number;
    event_type: string;
    actor_type: string;
    source_run_id: string | null;
    created_at: string;
  }>;
}

interface MemoryPage {
  memories: AgentMemory[];
  next_cursor: string | null;
  has_more: boolean;
}

interface MemoryScopeSetting {
  scope: MemoryScope;
  enabled: boolean;
  max_active_memories: number;
  active_memory_count: number;
  candidate_memory_count: number;
  updated_at: string | null;
}

interface MemoryScopeSettingsResponse {
  settings: MemoryScopeSetting[];
}

const PAGE_SIZE = 50;

/**
 * Inspecting and deleting what Agents have remembered.
 *
 * The store shipped before it was reachable, which meant durable facts about a
 * person accumulated with no way to see or remove them. This screen exists to
 * close that: the list deliberately shows superseded and expired rows too, since
 * hiding them would make it impossible to understand why recall behaves as it
 * does.
 */
export default function AgentMemoriesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [scope, setScope] = useState<'all' | MemoryScope>('all');
  const [status, setStatus] = useState<'all' | MemoryStatus>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [scopeSettings, setScopeSettings] = useState<MemoryScopeSetting[]>([]);
  const [scopeSettingsLoading, setScopeSettingsLoading] = useState(true);
  const [updatingScope, setUpdatingScope] = useState<MemoryScope | null>(null);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState('');
  const [decidingId, setDecidingId] = useState('');
  const [detail, setDetail] = useState<MemoryGovernance | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState('');
  const loadAbortRef = useRef<AbortController | null>(null);
  const settingsAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (options: {
    silent?: boolean;
    append?: boolean;
    cursor?: string | null;
  } = {}) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    if (options.append) setLoadingMore(true);
    else if (!options.silent) setLoading(true);
    setError('');
    try {
      const response = await api.get<MemoryPage>('/agent-memories', {
        params: {
          limit: PAGE_SIZE,
          ...(scope === 'all' ? {} : { scope }),
          ...(status === 'all' ? {} : { status }),
          ...(search ? { search } : {}),
          ...(options.cursor ? { cursor: options.cursor } : {}),
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const page = response.data?.memories || [];
      setMemories((current) => {
        if (!options.append) return page;
        const existing = new Set(current.map((memory) => memory.id));
        return [...current, ...page.filter((memory) => !existing.has(memory.id))];
      });
      setNextCursor(response.data?.next_cursor || null);
      if (!options.append) setDetail(null);
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setError(readApiErrorMessage(requestError, t('agentMemories.loadFailed')));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [scope, search, status, t]);

  const loadScopeSettings = useCallback(async (options: { silent?: boolean } = {}) => {
    settingsAbortRef.current?.abort();
    const controller = new AbortController();
    settingsAbortRef.current = controller;
    if (!options.silent) setScopeSettingsLoading(true);
    setError('');
    try {
      const { data } = await api.get<MemoryScopeSettingsResponse>(
        '/agent-memories/settings/scopes',
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setScopeSettings(data?.settings || []);
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setError(readApiErrorMessage(requestError, t('agentMemories.scopeControls.loadFailed')));
    } finally {
      if (!controller.signal.aborted) setScopeSettingsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    return () => loadAbortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    void loadScopeSettings();
    return () => settingsAbortRef.current?.abort();
  }, [loadScopeSettings]);

  const submitSearch = useCallback(() => {
    const normalized = searchInput.trim();
    if (normalized === search) void load();
    else setSearch(normalized);
  }, [load, search, searchInput]);

  const forget = useCallback(async (memory: AgentMemory) => {
    if (!window.confirm(t('agentMemories.deleteConfirm'))) return;
    setDeletingId(memory.id);
    setError('');
    try {
      await api.delete(`/agent-memories/${memory.id}`);
      // Removed locally rather than refetching: the row is gone, and a refetch
      // would reshuffle the list under a user who is working through it.
      setMemories((current) => current.filter((item) => item.id !== memory.id));
      setDetail((current) => current?.memory.id === memory.id ? null : current);
      void loadScopeSettings({ silent: true });
    } catch (requestError) {
      setError(readApiErrorMessage(requestError, t('agentMemories.deleteFailed')));
    } finally {
      setDeletingId('');
    }
  }, [loadScopeSettings, t]);

  const decide = useCallback(async (
    memory: AgentMemory,
    decision: 'confirmed' | 'rejected',
  ) => {
    setDecidingId(`${memory.id}:${decision}`);
    setError('');
    try {
      const { data } = await api.post<AgentMemory>(
        `/agent-memories/${memory.id}/decision`,
        { decision },
      );
      setMemories((current) => status === 'candidate'
        ? current.filter((item) => item.id !== memory.id)
        : current.map((item) => item.id === data.id ? data : item));
      setDetail(null);
      void loadScopeSettings({ silent: true });
    } catch (requestError) {
      setError(readApiErrorMessage(requestError, t('agentMemories.decisionFailed')));
    } finally {
      setDecidingId('');
    }
  }, [loadScopeSettings, status, t]);

  const toggleScope = useCallback(async (setting: MemoryScopeSetting) => {
    setUpdatingScope(setting.scope);
    setError('');
    try {
      const { data } = await api.patch<MemoryScopeSetting>(
        '/agent-memories/settings/scopes',
        { scope: setting.scope, enabled: !setting.enabled },
      );
      setScopeSettings((current) => current.map((item) => (
        item.scope === data.scope ? data : item
      )));
      // `active` is server-owned and includes the scope gate, so refresh rather
      // than duplicating recall eligibility rules in the client.
      await load({ silent: true });
    } catch (requestError) {
      setError(readApiErrorMessage(requestError, t('agentMemories.scopeControls.updateFailed')));
    } finally {
      setUpdatingScope(null);
    }
  }, [load, t]);

  const loadDetail = useCallback(async (memory: AgentMemory) => {
    if (detail?.memory.id === memory.id) {
      setDetail(null);
      return;
    }
    setDetailLoadingId(memory.id);
    setError('');
    try {
      const { data } = await api.get<MemoryGovernance>(`/agent-memories/${memory.id}`);
      setDetail(data);
    } catch (requestError) {
      setError(readApiErrorMessage(requestError, t('agentMemories.detailFailed')));
    } finally {
      setDetailLoadingId('');
    }
  }, [detail?.memory.id, t]);

  const trustLabel = useCallback((trust: MemoryTrust) => (
    t(`agentMemories.trust.${trust}`)
  ), [t]);

  const scopeOptions = useMemo(() => ([
    { value: 'all', label: t('agentMemories.scope.all') },
    { value: 'user', label: t('agentMemories.scope.user') },
    { value: 'project', label: t('agentMemories.scope.project') },
    { value: 'agent', label: t('agentMemories.scope.agent') },
  ]), [t]);
  const statusOptions = useMemo(() => ([
    { value: 'all', label: t('agentMemories.status.all') },
    { value: 'candidate', label: t('agentMemories.status.candidate') },
    { value: 'confirmed', label: t('agentMemories.status.confirmed') },
    { value: 'rejected', label: t('agentMemories.status.rejected') },
  ]), [t]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <header className="flex flex-wrap items-center gap-3">
        <Brain className="h-5 w-5 text-indigo-500" aria-hidden="true" />
        <h1 className="text-lg font-semibold">{t('agentMemories.title')}</h1>
        <p className="basis-full text-xs text-gray-500 dark:text-gray-400">
          {t('agentMemories.subtitle')}
        </p>
        <form
          className="ml-auto flex min-w-56 flex-1 items-center sm:max-w-xs"
          onSubmit={(event) => {
            event.preventDefault();
            submitSearch();
          }}
        >
          <label className="relative w-full">
            <span className="sr-only">{t('agentMemories.search')}</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              maxLength={200}
              placeholder={t('agentMemories.searchPlaceholder')}
              className="w-full rounded border border-gray-300 bg-transparent py-1.5 pl-8 pr-2 text-xs outline-none focus:border-indigo-500 dark:border-gray-600"
            />
          </label>
        </form>
        <div className="flex items-center gap-2">
          <SelectField
            aria-label={t('agentMemories.scope.label')}
            value={scope}
            onChange={(event) => setScope(event.target.value as 'all' | MemoryScope)}
          >
            {scopeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </SelectField>
          <SelectField
            aria-label={t('agentMemories.status.label')}
            value={status}
            onChange={(event) => setStatus(event.target.value as 'all' | MemoryStatus)}
          >
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </SelectField>
          <button
            type="button"
            onClick={() => void Promise.all([
              load({ silent: true }),
              loadScopeSettings({ silent: true }),
            ])}
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs
              hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('agentMemories.refresh')}
          </button>
        </div>
      </header>

      <section aria-labelledby="memory-scope-controls" className="space-y-2">
        <div>
          <h2 id="memory-scope-controls" className="text-sm font-medium">
            {t('agentMemories.scopeControls.title')}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('agentMemories.scopeControls.description')}
          </p>
        </div>
        {scopeSettingsLoading ? (
          <div className="flex items-center gap-2 rounded border border-gray-200 p-3 text-xs text-gray-500 dark:border-gray-700">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t('agentMemories.scopeControls.loading')}
          </div>
        ) : scopeSettings.length > 0 ? (
          <div className="grid gap-2 md:grid-cols-3">
            {scopeSettings.map((setting) => {
              const scopeLabel = t(`agentMemories.scope.${setting.scope}`);
              const quotaPercent = Math.min(
                100,
                Math.round((setting.active_memory_count / setting.max_active_memories) * 100),
              );
              return (
                <div
                  key={setting.scope}
                  className={`rounded border p-3 ${setting.enabled
                    ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20'
                    : 'border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20'}`}
                >
                  <div className="flex items-start gap-2">
                    {setting.enabled ? (
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                    ) : (
                      <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium">{scopeLabel}</h3>
                      <p className={`text-xs ${setting.enabled
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-amber-700 dark:text-amber-300'}`}
                      >
                        {t(setting.enabled
                          ? 'agentMemories.scopeControls.enabled'
                          : 'agentMemories.scopeControls.disabled')}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={setting.enabled}
                      aria-label={t(setting.enabled
                        ? 'agentMemories.scopeControls.disableScope'
                        : 'agentMemories.scopeControls.enableScope', { scope: scopeLabel })}
                      disabled={updatingScope !== null}
                      onClick={() => void toggleScope(setting)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2
                        disabled:cursor-not-allowed disabled:opacity-50 ${setting.enabled
                        ? 'bg-emerald-600'
                        : 'bg-gray-300 dark:bg-gray-600'}`}
                    >
                      <span
                        className={`inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition-transform
                          ${setting.enabled ? 'translate-x-5' : 'translate-x-0.5'}`}
                      >
                        {updatingScope === setting.scope ? (
                          <Loader2 className="h-3 w-3 animate-spin text-gray-500" aria-hidden="true" />
                        ) : null}
                      </span>
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap justify-between gap-1 text-[11px] text-gray-600 dark:text-gray-400">
                    <span>{t('agentMemories.scopeControls.quotaUsage', {
                      active: setting.active_memory_count,
                      max: setting.max_active_memories,
                    })}</span>
                    <span>{t('agentMemories.scopeControls.candidateCount', {
                      count: setting.candidate_memory_count,
                    })}</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={t('agentMemories.scopeControls.quotaLabel', { scope: scopeLabel })}
                    aria-valuemin={0}
                    aria-valuemax={setting.max_active_memories}
                    aria-valuenow={setting.active_memory_count}
                    className="mt-1 h-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
                  >
                    <div
                      className={`h-full rounded-full ${quotaPercent >= 90 ? 'bg-amber-500' : 'bg-indigo-500'}`}
                      style={{ width: `${quotaPercent}%` }}
                    />
                  </div>
                  <p className="mt-2 text-[11px] leading-4 text-gray-600 dark:text-gray-400">
                    {t(setting.enabled
                      ? 'agentMemories.scopeControls.enabledDescription'
                      : 'agentMemories.scopeControls.disabledDescription')}
                  </p>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm
            text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('common.loading')}
        </div>
      ) : memories.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('agentMemories.empty')}</p>
      ) : (
        <ul className="flex-1 space-y-2 overflow-y-auto">
          {memories.map((memory) => (
            <li
              key={memory.id}
              className={`rounded border p-3 text-sm ${memory.active
                ? 'border-gray-200 dark:border-gray-700'
                : 'border-dashed border-gray-300 opacity-60 dark:border-gray-700'}`}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words">{memory.content}</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                    <span>{t(`agentMemories.kind.${memory.kind}`)}</span>
                    <span>
                      {t(`agentMemories.scope.${memory.scope}`)}
                      {memory.scope_ref_name ? ` · ${memory.scope_ref_name}` : ''}
                    </span>
                    {/* Trust is shown because a tool-derived memory is the one an
                        attacker could have planted. */}
                    <span>{trustLabel(memory.source_trust)}</span>
                    <span>{t(`agentMemories.status.${memory.status}`)}</span>
                    <span>{t('agentMemories.confidence', { value: Math.round(memory.confidence * 100) })}</span>
                    <span>{t('agentMemories.recallCount', { count: memory.recall_count })}</span>
                    {memory.provenance_run_id ? (
                      <button
                        type="button"
                        onClick={() => navigate(`/agents?tab=runs&runId=${encodeURIComponent(memory.provenance_run_id!)}`)}
                        className="text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {t('agentMemories.provenanceRun', {
                          id: memory.provenance_run_id.slice(0, 8),
                        })}
                      </button>
                    ) : null}
                    {memory.superseded_by ? <span>{t('agentMemories.superseded')}</span> : null}
                    {memory.expires_at ? (
                      <span>
                        {t('agentMemories.expiresAt', {
                          time: new Date(memory.expires_at).toLocaleString(),
                        })}
                      </span>
                    ) : null}
                    {!memory.has_embedding ? <span>{t('agentMemories.noEmbedding')}</span> : null}
                  </p>
                </div>
                {memory.status === 'candidate' ? (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => void decide(memory, 'confirmed')}
                      disabled={Boolean(decidingId)}
                      aria-label={t('agentMemories.confirm')}
                      title={t('agentMemories.confirm')}
                      className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
                    >
                      {decidingId === `${memory.id}:confirmed`
                        ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        : <Check className="h-4 w-4" aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void decide(memory, 'rejected')}
                      disabled={Boolean(decidingId)}
                      aria-label={t('agentMemories.reject')}
                      title={t('agentMemories.reject')}
                      className="rounded p-1.5 text-amber-600 hover:bg-amber-50 disabled:opacity-50 dark:hover:bg-amber-950"
                    >
                      {decidingId === `${memory.id}:rejected`
                        ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        : <X className="h-4 w-4" aria-hidden="true" />}
                    </button>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => void loadDetail(memory)}
                  disabled={Boolean(detailLoadingId)}
                  aria-label={t('agentMemories.inspect')}
                  title={t('agentMemories.inspect')}
                  className="shrink-0 rounded p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800"
                >
                  {detailLoadingId === memory.id
                    ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  onClick={() => void forget(memory)}
                  disabled={deletingId === memory.id}
                  aria-label={t('agentMemories.delete')}
                  title={t('agentMemories.delete')}
                  className="shrink-0 rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600
                    disabled:opacity-50 dark:hover:bg-red-950"
                >
                  {deletingId === memory.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
              {detail?.memory.id === memory.id ? (
                <div className="mt-3 grid gap-3 border-t border-gray-200 pt-3 text-xs dark:border-gray-700 md:grid-cols-2">
                  <div>
                    <h2 className="font-medium">{t('agentMemories.evidence')}</h2>
                    {detail.evidence.length === 0 ? (
                      <p className="mt-1 text-gray-500">{t('agentMemories.noEvidence')}</p>
                    ) : (
                      <ul className="mt-1 space-y-1 text-gray-500 dark:text-gray-400">
                        {detail.evidence.map((item) => (
                          <li key={item.id}>{item.evidence_kind} · {new Date(item.created_at).toLocaleString()}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <h2 className="font-medium">{t('agentMemories.events')}</h2>
                    <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto text-gray-500 dark:text-gray-400">
                      {detail.events.map((item) => (
                        <li key={item.id}>{item.event_type} · {item.actor_type} · {new Date(item.created_at).toLocaleString()}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
          {nextCursor ? (
            <li className="flex justify-center py-2">
              <button
                type="button"
                onClick={() => void load({ append: true, cursor: nextCursor })}
                disabled={loadingMore}
                className="inline-flex items-center gap-2 rounded border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
              >
                {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                {t('agentMemories.loadMore')}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Brain, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { readApiErrorMessage } from '../lib/apiError';
import SelectField from '../components/SelectField';

type MemoryScope = 'user' | 'project' | 'agent';
type MemoryTrust = 'user_stated' | 'agent_inferred' | 'tool_derived';

interface AgentMemory {
  id: string;
  scope: MemoryScope;
  scope_ref_id: string | null;
  kind: 'fact' | 'preference' | 'decision' | 'summary';
  content: string;
  source_trust: MemoryTrust;
  provenance_run_id: string | null;
  superseded_by: string | null;
  expires_at: string | null;
  has_embedding: boolean;
  /** Whether recall would still return this row. Decided by the server. */
  active: boolean;
  created_at: string;
  updated_at: string;
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
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [scope, setScope] = useState<'all' | MemoryScope>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState('');

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    setError('');
    try {
      const response = await api.get('/agent-memories', {
        params: {
          limit: PAGE_SIZE,
          ...(scope === 'all' ? {} : { scope }),
        },
      });
      setMemories(response.data?.memories || []);
    } catch (requestError) {
      setError(readApiErrorMessage(requestError, t('agentMemories.loadFailed')));
    } finally {
      setLoading(false);
    }
  }, [scope, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const forget = useCallback(async (memory: AgentMemory) => {
    setDeletingId(memory.id);
    setError('');
    try {
      await api.delete(`/agent-memories/${memory.id}`);
      // Removed locally rather than refetching: the row is gone, and a refetch
      // would reshuffle the list under a user who is working through it.
      setMemories((current) => current.filter((item) => item.id !== memory.id));
    } catch (requestError) {
      setError(readApiErrorMessage(requestError, t('agentMemories.deleteFailed')));
    } finally {
      setDeletingId('');
    }
  }, [t]);

  const trustLabel = useCallback((trust: MemoryTrust) => (
    t(`agentMemories.trust.${trust}`)
  ), [t]);

  const scopeOptions = useMemo(() => ([
    { value: 'all', label: t('agentMemories.scope.all') },
    { value: 'user', label: t('agentMemories.scope.user') },
    { value: 'project', label: t('agentMemories.scope.project') },
    { value: 'agent', label: t('agentMemories.scope.agent') },
  ]), [t]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <header className="flex flex-wrap items-center gap-3">
        <Brain className="h-5 w-5 text-indigo-500" aria-hidden="true" />
        <h1 className="text-lg font-semibold">{t('agentMemories.title')}</h1>
        <p className="basis-full text-xs text-gray-500 dark:text-gray-400">
          {t('agentMemories.subtitle')}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <SelectField
            aria-label={t('agentMemories.scope.label')}
            value={scope}
            onChange={(event) => setScope(event.target.value as 'all' | MemoryScope)}
          >
            {scopeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </SelectField>
          <button
            type="button"
            onClick={() => void load({ silent: true })}
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs
              hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('agentMemories.refresh')}
          </button>
        </div>
      </header>

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
                    <span>{t(`agentMemories.scope.${memory.scope}`)}</span>
                    {/* Trust is shown because a tool-derived memory is the one an
                        attacker could have planted. */}
                    <span>{trustLabel(memory.source_trust)}</span>
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

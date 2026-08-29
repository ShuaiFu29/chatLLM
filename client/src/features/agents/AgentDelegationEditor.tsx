import { useMemo, useState } from 'react';
import { GitBranch, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SelectField from '../../components/SelectField';
import {
  MAX_AGENT_DELEGATION_BINDINGS,
  createAgentDelegationBinding,
  isAvailableAgentCollaborator,
  parseAgentDelegationContextKeys,
} from './agentDelegationBindings';
import type {
  Agent,
  AgentDelegationBinding,
  AgentDelegationMode,
} from './types';

interface AgentDelegationEditorProps {
  value: AgentDelegationBinding[];
  mode: AgentDelegationMode;
  agents: Agent[];
  sourceAgentId?: string | null;
  sourceProjectSpaceId?: string | null;
  onChange(value: AgentDelegationBinding[]): void;
}

const fieldClass = 'w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text-main outline-none transition-colors focus:border-primary';

function ContextKeysInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string[];
  placeholder: string;
  onCommit(value: string[]): void;
}) {
  const [draft, setDraft] = useState(() => value.join(', '));
  return (
    <input
      className={fieldClass}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const parsed = parseAgentDelegationContextKeys(draft);
        setDraft(parsed.join(', '));
        onCommit(parsed);
      }}
      placeholder={placeholder}
    />
  );
}

export default function AgentDelegationEditor({
  value,
  mode,
  agents,
  sourceAgentId,
  sourceProjectSpaceId,
  onChange,
}: AgentDelegationEditorProps) {
  const { t } = useTranslation();
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const candidates = useMemo(() => agents
    .filter((candidate) => isAvailableAgentCollaborator(
      candidate,
      sourceAgentId,
      sourceProjectSpaceId,
    ))
    .sort((left, right) => left.name.localeCompare(right.name)), [
    agents,
    sourceAgentId,
    sourceProjectSpaceId,
  ]);
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  const updateBinding = (index: number, updates: Partial<AgentDelegationBinding>) => {
    onChange(value.map((binding, bindingIndex) => (
      bindingIndex === index ? { ...binding, ...updates } : binding
    )));
  };

  const addBinding = () => {
    const candidate = candidates.find((item) => item.id === selectedAgentId);
    if (!candidate || value.length >= MAX_AGENT_DELEGATION_BINDINGS) return;
    const binding = createAgentDelegationBinding(
      candidate,
      value,
      t('agents.delegation.defaultRole', { name: candidate.name }),
    );
    if (!binding) return;
    onChange([...value, binding]);
    setSelectedAgentId('');
  };

  return (
    <section className="space-y-4 rounded-xl border border-border bg-bg-base/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <GitBranch className="h-4 w-4 text-primary" />
            {t('agents.delegation.title')}
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-text-muted">
            {t('agents.delegation.description')}
          </p>
        </div>
        <span className="rounded border border-border px-2 py-1 text-[10px] text-text-muted">
          {value.length}/{MAX_AGENT_DELEGATION_BINDINGS}
        </span>
      </div>

      {mode === 'legacy_dynamic' ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100">
          <p>{t('agents.delegation.legacyWarning')}</p>
          <button
            type="button"
            onClick={() => onChange([])}
            className="mt-2 rounded border border-amber-400/40 px-2 py-1 font-medium hover:bg-amber-500/10"
          >
            {t('agents.delegation.migrateWithoutDelegation')}
          </button>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <SelectField
          value={selectedAgentId}
          onChange={(event) => setSelectedAgentId(event.target.value)}
          disabled={value.length >= MAX_AGENT_DELEGATION_BINDINGS}
        >
          <option value="">{t('agents.delegation.selectCollaborator')}</option>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name} · v{candidate.published_version ?? '—'}
            </option>
          ))}
        </SelectField>
        <button
          type="button"
          onClick={addBinding}
          disabled={!selectedAgentId || value.length >= MAX_AGENT_DELEGATION_BINDINGS}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> {t('agents.delegation.add')}
        </button>
      </div>
      {candidates.length === 0 ? (
        <p className="text-xs leading-5 text-text-muted">{t('agents.delegation.noCandidates')}</p>
      ) : null}

      <div className="space-y-3">
        {value.map((binding, index) => {
          const candidate = agentById.get(binding.agent_id);
          const currentPublishedVersionId = candidate?.published_version_id;
          const hasUpgrade = Boolean(
            currentPublishedVersionId
            && currentPublishedVersionId !== binding.agent_version_id,
          );
          return (
            <div key={`${binding.alias}:${binding.agent_id}:${index}`} className="space-y-3 rounded-xl border border-border bg-bg-base p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-main">
                    {candidate?.name || t('agents.delegation.unavailableCollaborator')}
                  </p>
                  <p className="mt-1 text-[10px] text-text-muted">
                    {t('agents.delegation.pinnedVersion')}: <code title={binding.agent_version_id}>{binding.agent_version_id.slice(0, 8)}</code>
                    {candidate?.published_version ? ` · v${candidate.published_version}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {hasUpgrade ? (
                    <button
                      type="button"
                      onClick={() => updateBinding(index, {
                        agent_version_id: currentPublishedVersionId!,
                      })}
                      className="rounded border border-amber-500/30 px-2 py-1 text-[10px] text-amber-300 hover:bg-amber-500/10"
                    >
                      {t('agents.delegation.upgradeVersion', {
                        version: candidate?.published_version ?? '—',
                      })}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onChange(value.filter((_, bindingIndex) => bindingIndex !== index))}
                    aria-label={t('agents.delegation.remove')}
                    className="rounded p-1.5 text-red-300 hover:bg-red-500/10"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {!candidate ? (
                <p className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">
                  {t('agents.delegation.unavailableHint')}
                </p>
              ) : null}

              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-text-main">{t('agents.delegation.alias')}</span>
                  <input
                    className={fieldClass}
                    value={binding.alias}
                    maxLength={32}
                    pattern="[a-z][a-z0-9_]{0,31}"
                    onChange={(event) => updateBinding(index, { alias: event.target.value })}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-text-main">{t('agents.delegation.maxParallelism')}</span>
                  <input
                    className={fieldClass}
                    type="number"
                    min={1}
                    max={16}
                    value={binding.max_parallelism}
                    onChange={(event) => updateBinding(index, {
                      max_parallelism: Math.min(16, Math.max(1, Number(event.target.value))),
                    })}
                  />
                </label>
                <label className="space-y-1.5 md:col-span-2">
                  <span className="text-xs font-medium text-text-main">{t('agents.delegation.role')}</span>
                  <textarea
                    className={`${fieldClass} min-h-20 resize-y`}
                    value={binding.role}
                    maxLength={500}
                    onChange={(event) => updateBinding(index, { role: event.target.value })}
                  />
                </label>
                <label className="space-y-1.5 md:col-span-2">
                  <span className="text-xs font-medium text-text-main">{t('agents.delegation.contextKeys')}</span>
                  <ContextKeysInput
                    value={binding.allowed_context_keys}
                    onCommit={(contextKeys) => updateBinding(index, {
                      allowed_context_keys: contextKeys,
                    })}
                    placeholder={t('agents.delegation.contextKeysPlaceholder')}
                  />
                  <span className="block text-[10px] leading-4 text-text-muted">
                    {t('agents.delegation.contextKeysHint')}
                  </span>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

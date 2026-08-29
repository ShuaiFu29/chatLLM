import { useTranslation } from 'react-i18next';
import SelectField from '../../components/SelectField';
import type {
  AgentMemoryPolicy,
  AgentMemoryScope,
  AgentMemorySourceTrust,
} from './types';
import {
  clampAgentSummaryTokens,
  setConversationHistoryEnabled,
  setRollingSummaryEnabled,
} from './agentMemoryPolicy';

interface AgentMemoryPolicyEditorProps {
  value: AgentMemoryPolicy;
  hasProjectSpace: boolean;
  onChange(value: AgentMemoryPolicy): void;
}

const scopes: AgentMemoryScope[] = ['user', 'project', 'agent'];
const fieldClass = 'w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text-main outline-none transition-colors focus:border-primary';

const toggleScope = (
  values: AgentMemoryScope[],
  scope: AgentMemoryScope,
) => {
  const selected = new Set(values);
  if (selected.has(scope)) selected.delete(scope);
  else selected.add(scope);
  return scopes.filter((item) => selected.has(item));
};

export default function AgentMemoryPolicyEditor({
  value,
  hasProjectSpace,
  onChange,
}: AgentMemoryPolicyEditorProps) {
  const { t } = useTranslation();

  const updateConversation = (enabled: boolean) => onChange(
    setConversationHistoryEnabled(value, enabled),
  );

  const updateRollingSummary = (enabled: boolean) => onChange(
    setRollingSummaryEnabled(value, enabled),
  );

  const updateReadAllowedScope = (scope: AgentMemoryScope) => {
    const allowedScopes = toggleScope(value.read.allowed_scopes, scope);
    const autoScopes = value.read.auto_scopes.filter((item) => allowedScopes.includes(item));
    const autoRecall = autoScopes.length > 0;
    onChange({
      ...value,
      read: { ...value.read, allowed_scopes: allowedScopes, auto_scopes: autoScopes, auto_recall: autoRecall },
      subagent: autoRecall
        ? value.subagent
        : { share_recalled_memory: false, max_items: 0, token_budget: 0 },
    });
  };

  const updateAutoScope = (scope: AgentMemoryScope) => {
    const autoScopes = toggleScope(value.read.auto_scopes, scope);
    const allowedScopes = value.read.allowed_scopes.includes(scope)
      ? value.read.allowed_scopes
      : scopes.filter((item) => item === scope || value.read.allowed_scopes.includes(item));
    const autoRecall = autoScopes.length > 0;
    onChange({
      ...value,
      read: { ...value.read, allowed_scopes: allowedScopes, auto_scopes: autoScopes, auto_recall: autoRecall },
      subagent: autoRecall
        ? value.subagent
        : { share_recalled_memory: false, max_items: 0, token_budget: 0 },
    });
  };

  const updateWriteEnabled = (enabled: boolean) => onChange({
    ...value,
    write: {
      ...value.write,
      enabled,
      allowed_scopes: enabled
        ? (value.write.allowed_scopes.length > 0 ? value.write.allowed_scopes : ['user', 'project', 'agent'])
        : [],
    },
  });

  const updateSubagentSharing = (enabled: boolean) => onChange({
    ...value,
    subagent: enabled
      ? {
        share_recalled_memory: true,
        max_items: Math.max(1, value.subagent.max_items || 5),
        token_budget: Math.max(1, value.subagent.token_budget || 256),
      }
      : { share_recalled_memory: false, max_items: 0, token_budget: 0 },
  });

  return (
    <div className="space-y-4 rounded-xl border border-border bg-bg-base/60 p-4 md:col-span-3">
      <div>
        <h4 className="text-sm font-semibold text-text-main">{t('agents.memoryPolicy.title')}</h4>
        <p className="mt-1 text-xs leading-5 text-text-muted">{t('agents.memoryPolicy.description')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="flex items-start gap-3 rounded-lg border border-border p-3">
          <input
            type="checkbox"
            className="mt-1 accent-primary"
            checked={value.conversation.enabled}
            onChange={(event) => updateConversation(event.target.checked)}
          />
          <span>
            <span className="block text-sm font-medium text-text-main">{t('agents.memoryPolicy.conversation')}</span>
            <span className="mt-1 block text-xs text-text-muted">{t('agents.memoryPolicy.conversationHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-lg border border-border p-3">
          <input
            type="checkbox"
            className="mt-1 accent-primary"
            checked={value.persona.enabled}
            onChange={(event) => onChange({ ...value, persona: { enabled: event.target.checked } })}
          />
          <span>
            <span className="block text-sm font-medium text-text-main">{t('agents.memoryPolicy.persona')}</span>
            <span className="mt-1 block text-xs text-text-muted">{t('agents.memoryPolicy.personaHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-lg border border-border p-3">
          <input
            type="checkbox"
            className="mt-1 accent-primary"
            checked={value.project_context.enabled}
            disabled={!hasProjectSpace && !value.project_context.enabled}
            onChange={(event) => onChange({ ...value, project_context: { enabled: event.target.checked } })}
          />
          <span>
            <span className="block text-sm font-medium text-text-main">{t('agents.memoryPolicy.projectContext')}</span>
            <span className="mt-1 block text-xs text-text-muted">{t('agents.memoryPolicy.projectContextHint')}</span>
          </span>
        </label>
      </div>

      {value.conversation.enabled ? (
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <label className="block space-y-2">
            <span className="text-xs font-medium text-text-main">{t('agents.memoryPolicy.historyLimit')}</span>
            <input
              className={fieldClass}
              type="number"
              min="1"
              max="100"
              value={value.conversation.message_limit}
              onChange={(event) => onChange({
                ...value,
                conversation: {
                  ...value.conversation,
                  message_limit: Math.min(100, Math.max(1, Number(event.target.value))),
                },
              })}
            />
          </label>
          <div className="space-y-2 rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-xs font-medium text-text-main">
              <input
                type="checkbox"
                className="accent-primary"
                checked={value.conversation.rolling_summary.enabled}
                onChange={(event) => updateRollingSummary(event.target.checked)}
              />
              {t('agents.memoryPolicy.rollingSummary')}
            </label>
            <p className="text-xs leading-5 text-text-muted">{t('agents.memoryPolicy.rollingSummaryHint')}</p>
            {value.conversation.rolling_summary.enabled ? (
              <label className="block space-y-2">
                <span className="text-xs font-medium text-text-main">{t('agents.memoryPolicy.summaryTokenBudget')}</span>
                <input
                  className={fieldClass}
                  type="number"
                  min="32"
                  max="4000"
                  value={value.conversation.rolling_summary.max_tokens}
                  onChange={(event) => onChange({
                    ...value,
                    conversation: {
                      ...value.conversation,
                      rolling_summary: {
                        enabled: true,
                        max_tokens: clampAgentSummaryTokens(Number(event.target.value)),
                      },
                    },
                  })}
                />
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 border-t border-border pt-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div>
            <h5 className="text-sm font-medium text-text-main">{t('agents.memoryPolicy.readTitle')}</h5>
            <p className="mt-1 text-xs text-text-muted">{t('agents.memoryPolicy.readHint')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="space-y-2 rounded-lg border border-border p-3">
              <legend className="px-1 text-xs font-medium text-text-main">{t('agents.memoryPolicy.allowedScopes')}</legend>
              {scopes.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-xs text-text-main">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={value.read.allowed_scopes.includes(scope)}
                    onChange={() => updateReadAllowedScope(scope)}
                  />
                  {t(`agents.memoryPolicy.scopes.${scope}`)}
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-2 rounded-lg border border-border p-3">
              <legend className="px-1 text-xs font-medium text-text-main">{t('agents.memoryPolicy.autoScopes')}</legend>
              {scopes.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-xs text-text-main">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={value.read.auto_scopes.includes(scope)}
                    onChange={() => updateAutoScope(scope)}
                  />
                  {t(`agents.memoryPolicy.scopes.${scope}`)}
                </label>
              ))}
            </fieldset>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-2">
              <span className="text-xs font-medium text-text-main">Top K</span>
              <input
                className={fieldClass}
                type="number"
                min="1"
                max="20"
                value={value.read.top_k}
                onChange={(event) => onChange({ ...value, read: { ...value.read, top_k: Math.min(20, Math.max(1, Number(event.target.value))) } })}
              />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-medium text-text-main">{t('agents.memoryPolicy.tokenBudget')}</span>
              <input
                className={fieldClass}
                type="number"
                min="1"
                max="1000"
                value={value.read.token_budget}
                onChange={(event) => onChange({ ...value, read: { ...value.read, token_budget: Math.min(1000, Math.max(1, Number(event.target.value))) } })}
              />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-medium text-text-main">{t('agents.memoryPolicy.minimumTrust')}</span>
              <SelectField
                value={value.read.min_trust}
                onChange={(event) => onChange({ ...value, read: { ...value.read, min_trust: event.target.value as AgentMemorySourceTrust } })}
              >
                {(['user_stated', 'agent_inferred', 'tool_derived'] as const).map((trust) => (
                  <option key={trust} value={trust}>{t(`agents.memoryPolicy.trust.${trust}`)}</option>
                ))}
              </SelectField>
            </label>
          </div>
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium text-text-main">
            <input
              type="checkbox"
              className="accent-primary"
              checked={value.write.enabled}
              onChange={(event) => updateWriteEnabled(event.target.checked)}
            />
            {t('agents.memoryPolicy.writeTitle')}
          </label>
          {value.write.enabled ? (
            <>
              <fieldset className="space-y-2 rounded-lg border border-border p-3">
                <legend className="px-1 text-xs font-medium text-text-main">{t('agents.memoryPolicy.writeScopes')}</legend>
                {scopes.map((scope) => (
                  <label key={scope} className="mr-4 inline-flex items-center gap-2 text-xs text-text-main">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={value.write.allowed_scopes.includes(scope)}
                      onChange={() => {
                        const nextScopes = toggleScope(value.write.allowed_scopes, scope);
                        if (nextScopes.length === 0) return;
                        onChange({ ...value, write: { ...value.write, allowed_scopes: nextScopes } });
                      }}
                    />
                    {t(`agents.memoryPolicy.scopes.${scope}`)}
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-xs font-medium text-text-main">{t('agents.memoryPolicy.defaultTtl')}</span>
                  <input
                    className={fieldClass}
                    type="number"
                    min="1"
                    max="365"
                    value={value.write.default_ttl_days ?? ''}
                    placeholder={t('agents.memoryPolicy.noExpiry')}
                    onChange={(event) => onChange({
                      ...value,
                      write: {
                        ...value.write,
                        default_ttl_days: event.target.value
                          ? Math.min(365, Math.max(1, Number(event.target.value)))
                          : null,
                      },
                    })}
                  />
                </label>
                <label className="flex items-center gap-2 pt-6 text-xs text-text-main">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={value.write.require_confirmation}
                    onChange={(event) => onChange({
                      ...value,
                      write: { ...value.write, require_confirmation: event.target.checked },
                    })}
                  />
                  {t('agents.memoryPolicy.requireConfirmation')}
                </label>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <label className="flex items-center gap-2 text-sm font-medium text-text-main">
          <input
            type="checkbox"
            className="accent-primary"
            checked={value.subagent.share_recalled_memory}
            disabled={!value.read.auto_recall}
            onChange={(event) => updateSubagentSharing(event.target.checked)}
          />
          {t('agents.memoryPolicy.shareSubagents')}
        </label>
        <p className="text-xs leading-5 text-text-muted">{t('agents.memoryPolicy.shareSubagentsHint')}</p>
        {value.subagent.share_recalled_memory ? (
          <div className="grid max-w-xl gap-3 sm:grid-cols-2">
            <label className="space-y-2">
              <span className="text-xs font-medium text-text-main">{t('agents.memoryPolicy.maxSharedItems')}</span>
              <input
                className={fieldClass}
                type="number"
                min="1"
                max="20"
                value={value.subagent.max_items}
                onChange={(event) => onChange({ ...value, subagent: { ...value.subagent, max_items: Math.min(20, Math.max(1, Number(event.target.value))) } })}
              />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-medium text-text-main">{t('agents.memoryPolicy.tokenBudget')}</span>
              <input
                className={fieldClass}
                type="number"
                min="1"
                max="1000"
                value={value.subagent.token_budget}
                onChange={(event) => onChange({ ...value, subagent: { ...value.subagent, token_budget: Math.min(1000, Math.max(1, Number(event.target.value))) } })}
              />
            </label>
          </div>
        ) : null}
      </div>
    </div>
  );
}

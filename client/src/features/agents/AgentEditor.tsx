import { useMemo, useState } from 'react';
import { Bot, Copy, Power, Save, Send, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import SelectField from '../../components/SelectField';
import { readApiErrorMessage } from '../../lib/apiError';
import type { ProjectSpace } from '../../stores/useProjectSpaceStore';
import AgentVersionHistory from './AgentVersionHistory';
import AgentMemoryPolicyEditor from './AgentMemoryPolicyEditor';
import AgentDelegationEditor from './AgentDelegationEditor';
import { memoryPolicyFromPreset, modeForMemoryPolicy } from './agentMemoryPolicy';
import {
  DISPATCH_SUBAGENTS_TOOL_KEY,
  findAgentDelegationBindingIssue,
  syncDelegationToolBinding,
} from './agentDelegationBindings';
import {
  pinAgentToolBindingVersion,
  toggleAgentToolBinding,
} from './agentToolBindings';
import type {
  Agent,
  AgentApprovalPolicy,
  AgentDelegationBinding,
  AgentDelegationMode,
  AgentInput,
  AgentMemoryMode,
  AgentMemoryPolicy,
  AgentResponseFormat,
  AgentToolBinding,
  AgentVisibility,
  BuiltinAgentTool,
  CustomAgentTool,
  ProviderHealthResponse,
} from './types';

interface AgentEditorProps {
  agent: Agent | null;
  projectSpaceId?: string | null;
  projectSpaces: ProjectSpace[];
  collaboratorAgents: Agent[];
  builtinTools: BuiltinAgentTool[];
  customTools: CustomAgentTool[];
  providerHealth: ProviderHealthResponse | null;
  onCreate(input: AgentInput): Promise<Agent>;
  onUpdate(id: string, input: Partial<AgentInput>): Promise<Agent>;
  onPublish(id: string, releaseNotes?: string): Promise<Agent>;
  onRollback(id: string, versionId: string): Promise<Agent>;
  onDuplicate(id: string): Promise<Agent>;
  onDisable(id: string, disabled: boolean): Promise<Agent>;
  onDelete(id: string): Promise<void>;
  onSelected(agent: Agent | null): void;
}

interface AgentFormState {
  name: string;
  description: string;
  avatar: string;
  visibility: AgentVisibility;
  project_space_id: string;
  instructions: string;
  model: string;
  temperature: number;
  max_iterations: number;
  max_duration_ms: number;
  max_output_tokens: number;
  memory_mode: AgentMemoryMode;
  memory_policy: AgentMemoryPolicy;
  response_format: AgentResponseFormat;
  outputSchemaText: string;
  approval_policy: AgentApprovalPolicy;
  tool_bindings: AgentToolBinding[];
  delegation_mode: AgentDelegationMode;
  delegation_bindings: AgentDelegationBinding[];
  welcome_message: string;
  suggestedPromptsText: string;
}

const formFromAgent = (
  agent: Agent | null,
  defaultModel: string,
): AgentFormState => ({
  name: agent?.name || '',
  description: agent?.description || '',
  avatar: agent?.avatar || '',
  visibility: agent?.visibility || 'private',
  // A new Agent starts global. The active workspace is a filter, not an
  // implicit scope; users can explicitly choose a workspace in the form.
  project_space_id: agent?.project_space_id || '',
  instructions: agent?.instructions || '',
  model: agent?.model || defaultModel,
  temperature: agent?.temperature ?? 0.7,
  max_iterations: agent?.max_iterations ?? 6,
  max_duration_ms: agent?.max_duration_ms ?? 120000,
  max_output_tokens: agent?.max_output_tokens ?? 4096,
  memory_mode: agent?.memory_mode || 'conversation',
  memory_policy: agent?.memory_policy || memoryPolicyFromPreset(
    agent?.memory_mode && agent.memory_mode !== 'custom' ? agent.memory_mode : 'conversation',
  ),
  response_format: agent?.response_format || 'markdown',
  outputSchemaText: JSON.stringify(agent?.output_schema || {}, null, 2),
  approval_policy: agent?.approval_policy || 'writes',
  tool_bindings: agent?.tool_bindings || [],
  delegation_mode: agent?.delegation_mode || 'explicit',
  delegation_bindings: agent?.delegation_bindings || [],
  welcome_message: agent?.welcome_message || '',
  suggestedPromptsText: (agent?.suggested_prompts || []).join('\n'),
});

const fieldClass = 'w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text-main outline-none transition-colors focus:border-primary';

export default function AgentEditor(props: AgentEditorProps) {
  const { t } = useTranslation();
  const defaultModel = props.providerHealth?.default_model || 'qwen-plus';
  const [form, setForm] = useState<AgentFormState>(() => formFromAgent(
    props.agent,
    defaultModel,
  ));
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState('');

  const modelOptions = useMemo(() => {
    const values = props.providerHealth?.providers.flatMap((provider) => (
      provider.models
        .filter((model) => model !== 'deepseek-reasoner')
        .map((model) => ({
          value: model,
          label: `${provider.name} · ${model}`,
          disabled: !provider.has_api_key,
        }))
    )) || [
      { value: 'deepseek-chat', label: 'DeepSeek · deepseek-chat', disabled: false },
      { value: 'qwen-plus', label: 'Qwen · qwen-plus', disabled: false },
      { value: 'moonshot-v1-8k', label: 'Moonshot · moonshot-v1-8k', disabled: false },
    ];
    if (!values.some((option) => option.value === form.model)) {
      values.unshift({ value: form.model, label: form.model, disabled: false });
    }
    return values;
  }, [form.model, props.providerHealth]);

  const toolOptions = useMemo(() => [
    ...props.builtinTools.filter((tool) => tool.key !== DISPATCH_SUBAGENTS_TOOL_KEY).map((tool) => ({
      key: tool.key,
      name: tool.name,
      description: tool.description,
      risk: tool.risk_level,
      kind: t('agents.builtinTool'),
      toolVersionId: undefined as string | undefined,
      toolVersion: undefined as number | undefined,
    })),
    ...props.customTools.map((tool) => ({
      key: `custom:${tool.id}`,
      name: tool.name,
      description: tool.description,
      risk: tool.risk_level,
      kind: tool.kind.toUpperCase(),
      toolVersionId: tool.current_version_id,
      toolVersion: tool.tool_version,
    })),
  ], [props.builtinTools, props.customTools, t]);

  const boundToolKeys = useMemo(
    () => new Set(form.tool_bindings.filter((binding) => binding.enabled !== false).map((binding) => binding.key)),
    [form.tool_bindings],
  );

  const toggleTool = (key: string) => {
    const selectedTool = toolOptions.find((tool) => tool.key === key);
    setForm((current) => ({
      ...current,
      tool_bindings: toggleAgentToolBinding(
        current.tool_bindings,
        key,
        selectedTool?.toolVersionId,
      ),
    }));
  };

  const buildInput = (): AgentInput => {
    let outputSchema: Record<string, unknown>;
    try {
      const parsed = JSON.parse(form.outputSchemaText || '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      outputSchema = parsed as Record<string, unknown>;
    } catch {
      throw new Error(t('agents.invalidOutputSchema'));
    }
    const delegationIssue = findAgentDelegationBindingIssue(form.delegation_bindings);
    if (delegationIssue) {
      throw new Error(t(`agents.delegation.issues.${delegationIssue}`));
    }
    return {
      name: form.name.trim(),
      description: form.description.trim(),
      avatar: form.avatar.trim(),
      visibility: form.visibility,
      project_space_id: form.project_space_id || null,
      instructions: form.instructions.trim(),
      model: form.model,
      temperature: form.temperature,
      max_iterations: form.max_iterations,
      max_duration_ms: form.max_duration_ms,
      max_output_tokens: form.max_output_tokens,
      memory_mode: form.memory_mode,
      memory_policy: form.memory_policy,
      response_format: form.response_format,
      output_schema: outputSchema,
      approval_policy: form.approval_policy,
      tool_bindings: syncDelegationToolBinding(
        form.tool_bindings,
        form.delegation_bindings,
      ),
      delegation_bindings: form.delegation_bindings,
      welcome_message: form.welcome_message.trim(),
      suggested_prompts: form.suggestedPromptsText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    };
  };

  const save = async () => {
    if (!form.name.trim() || !form.instructions.trim()) {
      toast.error(t('agents.nameInstructionsRequired'));
      return;
    }
    setSaving(true);
    try {
      const input = buildInput();
      const saved = props.agent
        ? await props.onUpdate(props.agent.id, input)
        : await props.onCreate(input);
      props.onSelected(saved);
      toast.success(t('agents.saved'));
    } catch (error) {
      // Show the server's reason (quota, invalid schema, tool out of scope)
      // instead of the generic "Request failed with status code 400".
      toast.error(readApiErrorMessage(error, t('agents.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (action: () => Promise<Agent>, message: string) => {
    try {
      const result = await action();
      props.onSelected(result);
      toast.success(message);
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.actionFailed')));
    }
  };

  const pinToolToCurrentVersion = (key: string, toolVersionId: string) => {
    setForm((current) => ({
      ...current,
      tool_bindings: pinAgentToolBindingVersion(
        current.tool_bindings,
        key,
        toolVersionId,
      ),
    }));
  };

  const publish = async () => {
    if (!props.agent) return;
    setPublishing(true);
    try {
      const published = await props.onPublish(props.agent.id, releaseNotes.trim());
      setReleaseNotes('');
      props.onSelected(published);
      toast.success(t('agents.published'));
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.publishFailed')));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-text-main">
              {props.agent ? props.agent.name : t('agents.newAgent')}
            </h2>
            <p className="text-xs text-text-muted">
              {props.agent
                ? t('agents.versionStatus', { version: props.agent.version, status: props.agent.status })
                : t('agents.newAgentHint')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {props.agent ? (
            <>
              <button
                type="button"
                onClick={() => void runAction(() => props.onDuplicate(props.agent!.id), t('agents.duplicated'))}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted hover:bg-bg-surface hover:text-text-main"
              >
                <Copy className="h-4 w-4" /> {t('common.copy')}
              </button>
              <button
                type="button"
                onClick={() => void runAction(
                  () => props.onDisable(props.agent!.id, props.agent!.status !== 'disabled'),
                  t(props.agent!.status === 'disabled' ? 'agents.enabled' : 'agents.disabled'),
                )}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted hover:bg-bg-surface hover:text-text-main"
              >
                <Power className="h-4 w-4" />
                {t(props.agent.status === 'disabled' ? 'agents.enable' : 'agents.disable')}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm(t('agents.deleteConfirm'))) return;
                  void props.onDelete(props.agent!.id)
                    .then(() => props.onSelected(null))
                    .catch((error: unknown) => {
                      toast.error(error instanceof Error ? error.message : t('agents.deleteFailed'));
                    });
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"
              >
                <Trash2 className="h-4 w-4" /> {t('common.delete')}
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            <Save className="h-4 w-4" /> {saving ? t('common.saving') : t('common.save')}
          </button>
          {props.agent && (props.agent.status !== 'published' || props.agent.has_unpublished_changes) ? (
            <button
              type="button"
              onClick={() => void publish()}
              disabled={publishing}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              <Send className="h-4 w-4" /> {publishing ? t('agents.publishing') : t('agents.publish')}
            </button>
          ) : null}
        </div>
      </div>

      {props.agent ? (
        <AgentVersionHistory
          key={`${props.agent.id}:${props.agent.current_version_id}`}
          agent={props.agent}
          onRollback={props.onRollback}
          onSelected={props.onSelected}
        />
      ) : null}

      {props.agent && (props.agent.status !== 'published' || props.agent.has_unpublished_changes) ? (
        <label className="block space-y-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
          <span className="text-sm font-medium text-text-main">{t('agents.releaseNotes')}</span>
          <textarea
            className={`${fieldClass} min-h-20 resize-y`}
            value={releaseNotes}
            maxLength={4000}
            onChange={(event) => setReleaseNotes(event.target.value)}
            placeholder={t('agents.releaseNotesPlaceholder')}
          />
          <span className="block text-xs leading-5 text-text-muted">{t('agents.releaseNotesHint')}</span>
        </label>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.name')}</span>
          <input className={fieldClass} value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.avatar')}</span>
          <input className={fieldClass} value={form.avatar} onChange={(event) => setForm((value) => ({ ...value, avatar: event.target.value }))} placeholder="🤖 or https://..." />
        </label>
        <label className="space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-text-main">{t('agents.description')}</span>
          <textarea className={`${fieldClass} min-h-20 resize-y`} value={form.description} onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.workspace')}</span>
          <SelectField value={form.project_space_id} onChange={(event) => setForm((value) => ({ ...value, project_space_id: event.target.value }))}>
            <option value="">{t('agents.allWorkspaces')}</option>
            {props.projectSpaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
          </SelectField>
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.visibility')}</span>
          <SelectField value={form.visibility} onChange={(event) => setForm((value) => ({ ...value, visibility: event.target.value as AgentVisibility }))}>
            <option value="private">{t('agents.private')}</option>
            <option value="project">{t('agents.projectShared')}</option>
          </SelectField>
        </label>
      </section>

      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold text-text-main">{t('agents.instructions')}</h3>
          <p className="mt-1 text-xs text-text-muted">{t('agents.instructionsHint')}</p>
        </div>
        <textarea className={`${fieldClass} min-h-56 resize-y font-mono leading-6`} value={form.instructions} onChange={(event) => setForm((value) => ({ ...value, instructions: event.target.value }))} />
      </section>

      <section className="grid gap-4 rounded-xl border border-border bg-bg-base/40 p-4 md:grid-cols-3">
        <label className="space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-text-main">{t('agents.model')}</span>
          <SelectField value={form.model} onChange={(event) => setForm((value) => ({ ...value, model: event.target.value }))}>
            {modelOptions.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
          </SelectField>
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('settings.temperature')}: {form.temperature}</span>
          <input className="mt-3 w-full accent-primary" type="range" min="0" max="2" step="0.1" value={form.temperature} onChange={(event) => setForm((value) => ({ ...value, temperature: Number(event.target.value) }))} />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.maxIterations')}</span>
          <input className={fieldClass} type="number" min="1" max="20" value={form.max_iterations} onChange={(event) => setForm((value) => ({ ...value, max_iterations: Number(event.target.value) }))} />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.timeoutSeconds')}</span>
          <input className={fieldClass} type="number" min="1" max="900" value={Math.round(form.max_duration_ms / 1000)} onChange={(event) => setForm((value) => ({ ...value, max_duration_ms: Number(event.target.value) * 1000 }))} />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.maxOutputTokens')}</span>
          <input className={fieldClass} type="number" min="128" max="100000" value={form.max_output_tokens} onChange={(event) => setForm((value) => ({ ...value, max_output_tokens: Number(event.target.value) }))} />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.memory')}</span>
          <SelectField
            value={form.memory_mode}
            onChange={(event) => {
              const mode = event.target.value as AgentMemoryMode;
              if (mode === 'custom') return;
              setForm((value) => ({
                ...value,
                memory_mode: mode,
                memory_policy: memoryPolicyFromPreset(mode),
              }));
            }}
          >
            {(['none', 'conversation', 'user', 'project', 'custom'] as const).map((mode) => (
              <option key={mode} value={mode}>{t(`agents.memoryModes.${mode}`)}</option>
            ))}
          </SelectField>
          <p className="text-xs leading-5 text-text-muted">{t('agents.memoryHint')}</p>
          {form.memory_mode === 'project' ? (
            <p className="text-xs leading-5 text-text-muted">{t('agents.memoryProjectHint')}</p>
          ) : null}
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.outputFormat')}</span>
          <SelectField value={form.response_format} onChange={(event) => setForm((value) => ({ ...value, response_format: event.target.value as AgentResponseFormat }))}>
            <option value="markdown">Markdown</option>
            <option value="json">JSON</option>
          </SelectField>
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.approvalPolicy')}</span>
          <SelectField value={form.approval_policy} onChange={(event) => setForm((value) => ({ ...value, approval_policy: event.target.value as AgentApprovalPolicy }))}>
            {(['never', 'writes', 'always'] as const).map((policy) => <option key={policy} value={policy}>{t(`agents.approvalPolicies.${policy}`)}</option>)}
          </SelectField>
        </label>
      </section>

      <AgentMemoryPolicyEditor
        value={form.memory_policy}
        hasProjectSpace={Boolean(form.project_space_id)}
        onChange={(memoryPolicy) => setForm((value) => ({
          ...value,
          memory_policy: memoryPolicy,
          memory_mode: modeForMemoryPolicy(memoryPolicy),
        }))}
      />

      <AgentDelegationEditor
        value={form.delegation_bindings}
        mode={form.delegation_mode}
        agents={props.collaboratorAgents}
        sourceAgentId={props.agent?.id}
        sourceProjectSpaceId={form.project_space_id || null}
        onChange={(delegationBindings) => setForm((value) => ({
          ...value,
          delegation_bindings: delegationBindings,
          tool_bindings: syncDelegationToolBinding(
            value.tool_bindings,
            delegationBindings,
          ),
        }))}
      />

      {form.response_format === 'json' ? (
        <label className="block space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.outputSchema')}</span>
          <textarea className={`${fieldClass} min-h-36 font-mono`} value={form.outputSchemaText} onChange={(event) => setForm((value) => ({ ...value, outputSchemaText: event.target.value }))} />
        </label>
      ) : null}

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-text-main">{t('agents.tools')}</h3>
          <p className="mt-1 text-xs text-text-muted">{t('agents.toolsHint')}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {toolOptions.map((toolOption) => {
            const checked = boundToolKeys.has(toolOption.key);
            const binding = form.tool_bindings.find((item) => item.key === toolOption.key);
            const pinnedVersionId = binding?.tool_version_id;
            const versionIsCurrent = !toolOption.toolVersionId
              || pinnedVersionId === toolOption.toolVersionId;
            return (
              <label key={toolOption.key} className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors ${checked ? 'border-primary/50 bg-primary/10' : 'border-border bg-bg-base hover:border-primary/30'}`}>
                <input type="checkbox" checked={checked} onChange={() => toggleTool(toolOption.key)} className="mt-1 accent-primary" />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-main">
                    {toolOption.name}
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">{toolOption.kind}</span>
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">{toolOption.risk}</span>
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-text-muted">{toolOption.description}</span>
                  {checked && toolOption.toolVersionId ? (
                    <span className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-text-muted">
                      <code title={pinnedVersionId}>{t('agents.pinnedToolVersion')}: {pinnedVersionId?.slice(0, 8) || '—'}</code>
                      {versionIsCurrent ? (
                        <span className="rounded border border-emerald-500/30 px-1.5 py-0.5 text-emerald-300">v{toolOption.toolVersion ?? '—'} {t('agents.currentVersion')}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            pinToolToCurrentVersion(toolOption.key, toolOption.toolVersionId!);
                          }}
                          className="rounded border border-amber-500/30 px-1.5 py-0.5 text-amber-300 hover:bg-amber-500/10"
                        >
                          {t('agents.upgradeToolVersion', { version: toolOption.toolVersion ?? '—' })}
                        </button>
                      )}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.welcomeMessage')}</span>
          <textarea className={`${fieldClass} min-h-28`} value={form.welcome_message} onChange={(event) => setForm((value) => ({ ...value, welcome_message: event.target.value }))} />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.suggestedPrompts')}</span>
          <textarea className={`${fieldClass} min-h-28`} value={form.suggestedPromptsText} onChange={(event) => setForm((value) => ({ ...value, suggestedPromptsText: event.target.value }))} placeholder={t('agents.onePromptPerLine')} />
        </label>
      </section>
    </div>
  );
}

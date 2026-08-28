import { useState } from 'react';
import { KeyRound, Save, Trash2, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import SelectField from '../../components/SelectField';
import { readApiErrorMessage } from '../../lib/apiError';
import type { ProjectSpace } from '../../stores/useProjectSpaceStore';
import type { CustomAgentTool, CustomAgentToolInput } from './types';

interface ToolEditorProps {
  tool: CustomAgentTool | null;
  projectSpaceId?: string | null;
  projectSpaces: ProjectSpace[];
  onCreate(input: CustomAgentToolInput): Promise<CustomAgentTool>;
  onUpdate(id: string, input: Partial<CustomAgentToolInput>): Promise<CustomAgentTool>;
  onDelete(id: string): Promise<void>;
  onSelected(tool: CustomAgentTool | null): void;
}

interface ToolFormState {
  name: string;
  description: string;
  kind: 'http' | 'mcp';
  risk_level: 'read' | 'write' | 'high';
  project_space_id: string;
  enabled: boolean;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  timeout_ms: number;
  response_path: string;
  tool_name: string;
  inputSchemaText: string;
  staticHeadersText: string;
  secretsText: string;
  clearSecrets: boolean;
}

const objectValue = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const formFromTool = (
  tool: CustomAgentTool | null,
): ToolFormState => {
  const configuration = objectValue(tool?.configuration);
  return {
    name: tool?.name || '',
    description: tool?.description || '',
    kind: tool?.kind || 'http',
    risk_level: tool?.risk_level || 'read',
    // Do not silently bind a new global tool to whichever workspace is active.
    project_space_id: tool?.project_space_id || '',
    enabled: tool?.enabled ?? true,
    endpoint: String(configuration.endpoint || ''),
    method: (configuration.method as ToolFormState['method']) || 'POST',
    timeout_ms: Number(configuration.timeout_ms || (tool?.kind === 'mcp' ? 20000 : 15000)),
    response_path: String(configuration.response_path || ''),
    tool_name: String(configuration.tool_name || ''),
    inputSchemaText: JSON.stringify(configuration.input_schema || {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }, null, 2),
    staticHeadersText: JSON.stringify(configuration.static_headers || {}, null, 2),
    secretsText: '',
    clearSecrets: false,
  };
};

const fieldClass = 'w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text-main outline-none transition-colors focus:border-primary';

const parseObject = (value: string, message: string) => {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(message);
  }
};

export default function ToolEditor(props: ToolEditorProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ToolFormState>(() => formFromTool(props.tool));
  const [saving, setSaving] = useState(false);

  const buildInput = (): CustomAgentToolInput => {
    const inputSchema = parseObject(form.inputSchemaText, t('agents.invalidInputSchema'));
    const staticHeaders = parseObject(form.staticHeadersText, t('agents.invalidHeaders'));
    const rawSecrets = form.secretsText.trim()
      ? parseObject(form.secretsText, t('agents.invalidSecrets'))
      : undefined;
    const secrets = rawSecrets
      ? Object.fromEntries(Object.entries(rawSecrets).map(([key, value]) => [key, String(value)]))
      : undefined;
    const configuration = form.kind === 'http'
      ? {
          endpoint: form.endpoint.trim(),
          method: form.method,
          timeout_ms: form.timeout_ms,
          input_schema: inputSchema,
          static_headers: staticHeaders,
          response_path: form.response_path.trim(),
        }
      : {
          endpoint: form.endpoint.trim(),
          tool_name: form.tool_name.trim(),
          timeout_ms: form.timeout_ms,
          input_schema: inputSchema,
        };
    return {
      name: form.name.trim(),
      description: form.description.trim(),
      kind: form.kind,
      risk_level: form.risk_level,
      project_space_id: form.project_space_id || null,
      configuration,
      secrets,
      enabled: form.enabled,
      ...(form.clearSecrets ? { clear_secrets: true } : {}),
    };
  };

  const save = async () => {
    if (!form.name.trim() || !form.endpoint.trim() || (form.kind === 'mcp' && !form.tool_name.trim())) {
      toast.error(t('agents.toolRequiredFields'));
      return;
    }
    setSaving(true);
    try {
      const input = buildInput();
      let saved: CustomAgentTool;
      if (props.tool) {
        const updates: Partial<CustomAgentToolInput> = { ...input };
        delete updates.kind;
        saved = await props.onUpdate(props.tool.id, updates);
      } else {
        saved = await props.onCreate(input);
      }
      props.onSelected(saved);
      toast.success(t('agents.toolSaved'));
    } catch (error) {
      // 409 "tool is still bound to an Agent", quota errors, and schema errors
      // all arrive in the response body, not in `error.message`.
      toast.error(readApiErrorMessage(error, t('agents.toolSaveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-amber-500/15 text-amber-300">
            <Wrench className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-main">{props.tool?.name || t('agents.newTool')}</h2>
            <p className="text-xs text-text-muted">{t('agents.customToolHint')}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {props.tool ? (
            <button
              type="button"
              onClick={() => {
                if (!window.confirm(t('agents.deleteToolConfirm'))) return;
                void props.onDelete(props.tool!.id)
                  .then(() => props.onSelected(null))
                  .catch((error: unknown) => {
                    toast.error(error instanceof Error ? error.message : t('agents.toolDeleteFailed'));
                  });
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"
            >
              <Trash2 className="h-4 w-4" /> {t('common.delete')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            <Save className="h-4 w-4" /> {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>

      <section className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.toolName')}</span>
          <input className={fieldClass} value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.toolType')}</span>
          <SelectField value={form.kind} disabled={Boolean(props.tool)} onChange={(event) => setForm((value) => ({ ...value, kind: event.target.value as 'http' | 'mcp' }))}>
            <option value="http">HTTP API</option>
            <option value="mcp">Remote MCP</option>
          </SelectField>
        </label>
        <label className="space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-text-main">{t('agents.description')}</span>
          <textarea className={`${fieldClass} min-h-20`} value={form.description} onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.workspace')}</span>
          <SelectField value={form.project_space_id} onChange={(event) => setForm((value) => ({ ...value, project_space_id: event.target.value }))}>
            <option value="">{t('agents.allWorkspaces')}</option>
            {props.projectSpaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
          </SelectField>
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.riskLevel')}</span>
          <SelectField value={form.risk_level} onChange={(event) => setForm((value) => ({ ...value, risk_level: event.target.value as ToolFormState['risk_level'] }))}>
            <option value="read">{t('agents.riskLevels.read')}</option>
            <option value="write">{t('agents.riskLevels.write')}</option>
            <option value="high">{t('agents.riskLevels.high')}</option>
          </SelectField>
        </label>
      </section>

      <section className="grid gap-4 rounded-xl border border-border bg-bg-base/40 p-4 md:grid-cols-2">
        <label className="space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-text-main">{t('agents.endpoint')}</span>
          <input className={fieldClass} value={form.endpoint} onChange={(event) => setForm((value) => ({ ...value, endpoint: event.target.value }))} placeholder="https://api.example.com/..." />
          <span className="block text-xs text-text-muted">{t('agents.endpointAllowlistHint')}</span>
        </label>
        {form.kind === 'http' ? (
          <>
            <label className="space-y-2">
              <span className="text-sm font-medium text-text-main">HTTP Method</span>
              <SelectField value={form.method} onChange={(event) => setForm((value) => ({ ...value, method: event.target.value as ToolFormState['method'] }))}>
                {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => <option key={method}>{method}</option>)}
              </SelectField>
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium text-text-main">{t('agents.responsePath')}</span>
              <input className={fieldClass} value={form.response_path} onChange={(event) => setForm((value) => ({ ...value, response_path: event.target.value }))} placeholder="data.items" />
            </label>
          </>
        ) : (
          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-text-main">MCP Tool Name</span>
            <input className={fieldClass} value={form.tool_name} onChange={(event) => setForm((value) => ({ ...value, tool_name: event.target.value }))} />
          </label>
        )}
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">{t('agents.timeoutMs')}</span>
          <input className={fieldClass} type="number" min="1000" max="60000" value={form.timeout_ms} onChange={(event) => setForm((value) => ({ ...value, timeout_ms: Number(event.target.value) }))} />
        </label>
        <label className="flex items-center gap-3 self-end rounded-lg border border-border px-3 py-2.5 text-sm text-text-main">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm((value) => ({ ...value, enabled: event.target.checked }))} className="accent-primary" />
          {t('agents.toolEnabled')}
        </label>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-main">JSON Input Schema</span>
          <textarea className={`${fieldClass} min-h-56 resize-y font-mono text-xs leading-5`} value={form.inputSchemaText} onChange={(event) => setForm((value) => ({ ...value, inputSchemaText: event.target.value }))} />
        </label>
        {form.kind === 'http' ? (
          <label className="space-y-2">
            <span className="text-sm font-medium text-text-main">{t('agents.staticHeaders')}</span>
            <textarea className={`${fieldClass} min-h-56 resize-y font-mono text-xs leading-5`} value={form.staticHeadersText} onChange={(event) => setForm((value) => ({ ...value, staticHeadersText: event.target.value }))} />
          </label>
        ) : null}
      </section>

      <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-200">
          <KeyRound className="h-4 w-4" /> {t('agents.credentials')}
        </div>
        <p className="mt-1 text-xs leading-5 text-text-muted">{t('agents.credentialsHint')}</p>
        <textarea className={`${fieldClass} mt-3 min-h-28 font-mono text-xs`} value={form.secretsText} onChange={(event) => setForm((value) => ({ ...value, secretsText: event.target.value, clearSecrets: false }))} placeholder={'{\n  "bearer_token": "..."\n}'} />
        {props.tool?.has_secrets ? (
          <label className="mt-3 flex items-center gap-2 text-xs text-text-muted">
            <input type="checkbox" checked={form.clearSecrets} onChange={(event) => setForm((value) => ({ ...value, clearSecrets: event.target.checked, secretsText: event.target.checked ? '' : value.secretsText }))} className="accent-primary" />
            {t('agents.clearCredentials')}
          </label>
        ) : null}
      </section>
    </div>
  );
}

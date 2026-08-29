import { useState } from 'react';
import { Activity, CheckCircle2, FileJson2, KeyRound, Plus, RefreshCw, Save, Search, Trash2, TriangleAlert, Wrench, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import SelectField from '../../components/SelectField';
import { readApiErrorMessage } from '../../lib/apiError';
import type { ProjectSpace } from '../../stores/useProjectSpaceStore';
import type {
  AgentToolDiagnosticInput,
  AgentToolDiagnosticHistoryPage,
  AgentToolDiagnosticHistoryQuery,
  AgentToolDiagnosticOperation,
  AgentToolDiagnosticResult,
  CustomAgentTool,
  CustomAgentToolInput,
  DiscoveredMcpTool,
  ImportedOpenApiOperation,
  OpenApiToolImportInput,
  OpenApiToolImportResult,
} from './types';
import AgentToolVersionHistory from './AgentToolVersionHistory';
import AgentToolDiagnosticHistory from './AgentToolDiagnosticHistory';
import {
  buildAgentToolSecrets,
  type AgentToolSecretDraft,
} from './agentToolSecrets';

interface ToolEditorProps {
  tool: CustomAgentTool | null;
  projectSpaceId?: string | null;
  projectSpaces: ProjectSpace[];
  onCreate(input: CustomAgentToolInput): Promise<CustomAgentTool>;
  onUpdate(id: string, input: Partial<CustomAgentToolInput>): Promise<CustomAgentTool>;
  onRotateSecrets(id: string): Promise<CustomAgentTool>;
  onDiagnose(id: string, input: AgentToolDiagnosticInput): Promise<AgentToolDiagnosticResult>;
  onListDiagnostics(
    id: string,
    query: AgentToolDiagnosticHistoryQuery,
  ): Promise<AgentToolDiagnosticHistoryPage>;
  onImportOpenApi(input: OpenApiToolImportInput): Promise<OpenApiToolImportResult>;
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
  idempotency_mode: 'none' | 'header';
  timeout_ms: number;
  response_path: string;
  tool_name: string;
  inputSchemaText: string;
  outputSchemaText: string;
  staticHeadersText: string;
  secretRows: AgentToolSecretDraft[];
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
    idempotency_mode: configuration.idempotency_mode === 'header' ? 'header' : 'none',
    timeout_ms: Number(configuration.timeout_ms || (tool?.kind === 'mcp' ? 20000 : 15000)),
    response_path: String(configuration.response_path || ''),
    tool_name: String(configuration.tool_name || ''),
    inputSchemaText: JSON.stringify(configuration.input_schema || {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }, null, 2),
    outputSchemaText: configuration.output_schema
      ? JSON.stringify(configuration.output_schema, null, 2)
      : '',
    staticHeadersText: JSON.stringify(configuration.static_headers || {}, null, 2),
    secretRows: [{ id: crypto.randomUUID(), key: '', value: '' }],
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
  const [rotating, setRotating] = useState(false);
  const [diagnosing, setDiagnosing] = useState<AgentToolDiagnosticOperation | null>(null);
  const [diagnostic, setDiagnostic] = useState<AgentToolDiagnosticResult | null>(null);
  const [diagnosticHistoryRevision, setDiagnosticHistoryRevision] = useState(0);
  const [testInputText, setTestInputText] = useState('{}');
  const [openApiText, setOpenApiText] = useState('');
  const [openApiBaseUrl, setOpenApiBaseUrl] = useState('');
  const [importingOpenApi, setImportingOpenApi] = useState(false);
  const [openApiImport, setOpenApiImport] = useState<OpenApiToolImportResult | null>(null);

  const buildInput = (): CustomAgentToolInput => {
    const inputSchema = parseObject(form.inputSchemaText, t('agents.invalidInputSchema'));
    const outputSchema = form.outputSchemaText.trim()
      ? parseObject(form.outputSchemaText, t('agents.invalidOutputSchema'))
      : undefined;
    const staticHeaders = parseObject(form.staticHeadersText, t('agents.invalidHeaders'));
    const secrets = form.clearSecrets ? undefined : buildAgentToolSecrets(form.secretRows);
    const configuration = form.kind === 'http'
      ? {
          endpoint: form.endpoint.trim(),
          method: form.method,
          idempotency_mode: form.method === 'GET' ? 'none' : form.idempotency_mode,
          timeout_ms: form.timeout_ms,
          input_schema: inputSchema,
          static_headers: staticHeaders,
          response_path: form.response_path.trim(),
          ...(outputSchema ? { output_schema: outputSchema } : {}),
        }
      : {
          endpoint: form.endpoint.trim(),
          tool_name: form.tool_name.trim(),
          timeout_ms: form.timeout_ms,
          input_schema: inputSchema,
          ...(outputSchema ? { output_schema: outputSchema } : {}),
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

  const rotateSecrets = async () => {
    if (!props.tool) return;
    setRotating(true);
    try {
      const saved = await props.onRotateSecrets(props.tool.id);
      props.onSelected(saved);
      toast.success(t('agents.credentialsRotated'));
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.credentialsRotateFailed')));
    } finally {
      setRotating(false);
    }
  };

  const diagnose = async (operation: AgentToolDiagnosticOperation) => {
    if (!props.tool) return;
    setDiagnosing(operation);
    try {
      const input = operation === 'safe_test'
        ? parseObject(testInputText, t('agents.invalidDiagnosticInput'))
        : undefined;
      const result = await props.onDiagnose(props.tool.id, {
        operation,
        ...(input ? { input } : {}),
      });
      setDiagnostic(result);
      setDiagnosticHistoryRevision((value) => value + 1);
      if (result.status === 'passed') toast.success(t('agents.diagnosticPassed'));
      else toast.error(result.error?.message || t('agents.diagnosticFailed'));
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.diagnosticFailed')));
    } finally {
      setDiagnosing(null);
    }
  };

  const importMcpTool = (tool: DiscoveredMcpTool) => {
    setForm((value) => ({
      ...value,
      tool_name: tool.name,
      inputSchemaText: JSON.stringify(tool.input_schema, null, 2),
      outputSchemaText: tool.output_schema
        ? JSON.stringify(tool.output_schema, null, 2)
        : '',
      description: value.description || tool.description,
    }));
    toast.success(t('agents.mcpSchemaImported'));
  };

  const inspectOpenApi = async () => {
    setImportingOpenApi(true);
    try {
      const document = parseObject(openApiText, t('agents.invalidOpenApiDocument'));
      const result = await props.onImportOpenApi({
        document,
        ...(openApiBaseUrl.trim() ? { base_url: openApiBaseUrl.trim() } : {}),
      });
      setOpenApiImport(result);
      toast.success(t('agents.openApiParsed', { count: result.operations.length }));
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.openApiImportFailed')));
    } finally {
      setImportingOpenApi(false);
    }
  };

  const loadOpenApiOperation = (operation: ImportedOpenApiOperation) => {
    setForm((value) => ({
      ...value,
      name: props.tool ? value.name : operation.name,
      description: value.description || operation.description,
      risk_level: operation.risk_level,
      endpoint: operation.configuration.endpoint,
      method: operation.configuration.method,
      idempotency_mode: 'none',
      timeout_ms: operation.configuration.timeout_ms,
      response_path: '',
      inputSchemaText: JSON.stringify(operation.input_schema, null, 2),
      outputSchemaText: operation.output_schema
        ? JSON.stringify(operation.output_schema, null, 2)
        : '',
      staticHeadersText: '{}',
      ...(!props.tool && operation.suggested_secret_keys.length > 0 ? {
        secretRows: operation.suggested_secret_keys.map((key) => ({
          id: crypto.randomUUID(),
          key,
          value: '',
        })),
      } : {}),
    }));
    toast.success(t('agents.openApiOperationLoaded'));
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
      const localSecretError = error instanceof Error
        && ['too_many_secrets', 'incomplete_secret', 'duplicate_secret'].includes(error.message);
      toast.error(localSecretError
        ? t('agents.invalidSecrets')
        : readApiErrorMessage(error, t('agents.toolSaveFailed')));
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
            {form.method !== 'GET' ? (
              <label className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-sm text-text-main md:col-span-2">
                <input
                  type="checkbox"
                  checked={form.idempotency_mode === 'header'}
                  onChange={(event) => setForm((value) => ({
                    ...value,
                    idempotency_mode: event.target.checked ? 'header' : 'none',
                  }))}
                  className="mt-0.5 accent-primary"
                />
                <span>
                  <span className="block font-medium">{t('agents.idempotencyHeader')}</span>
                  <span className="mt-1 block text-xs leading-5 text-text-muted">{t('agents.idempotencyHeaderHint')}</span>
                </span>
              </label>
            ) : null}
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

      {form.kind === 'http' ? (
        <details className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-indigo-200">
            <FileJson2 className="h-4 w-4" /> {t('agents.openApiImport')}
          </summary>
          <p className="mt-2 text-xs leading-5 text-text-muted">{t('agents.openApiImportHint')}</p>
          <div className="mt-4 grid gap-3">
            <label className="space-y-2">
              <span className="text-xs font-medium text-text-main">{t('agents.openApiDocument')}</span>
              <textarea
                className={`${fieldClass} min-h-48 resize-y font-mono text-xs leading-5`}
                value={openApiText}
                onChange={(event) => setOpenApiText(event.target.value)}
                placeholder='{"openapi":"3.1.0","info":{},"paths":{}}'
              />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-medium text-text-main">{t('agents.openApiBaseUrl')}</span>
              <input
                className={fieldClass}
                value={openApiBaseUrl}
                onChange={(event) => setOpenApiBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <button
              type="button"
              disabled={importingOpenApi || !openApiText.trim()}
              onClick={() => void inspectOpenApi()}
              className="inline-flex w-fit items-center gap-2 rounded-lg border border-indigo-500/30 px-3 py-2 text-xs text-indigo-100 hover:bg-indigo-500/10 disabled:opacity-50"
            >
              <Search className="h-3.5 w-3.5" />
              {importingOpenApi ? t('agents.parsingOpenApi') : t('agents.parseOpenApi')}
            </button>
          </div>
          {openApiImport ? (
            <div className="mt-4 space-y-3 border-t border-indigo-500/15 pt-3">
              <p className="text-xs text-text-muted">
                {openApiImport.title || 'OpenAPI'} · {openApiImport.version} · {openApiImport.operations.length} operations
              </p>
              {openApiImport.warnings.length > 0 ? (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-100/90">
                  {openApiImport.warnings.slice(0, 5).map((warning) => <div key={warning}>{warning}</div>)}
                </div>
              ) : null}
              <div className="max-h-96 space-y-2 overflow-auto pr-1">
                {openApiImport.operations.map((operation) => (
                  <div key={operation.key} className="rounded-lg border border-border bg-bg-base/60 px-3 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 font-mono text-xs text-indigo-200">{operation.method}</span>
                          <span className="break-all font-mono text-xs text-text-main">{operation.path}</span>
                        </div>
                        <p className="mt-1 text-xs text-text-muted">{operation.description || operation.operation_id}</p>
                        {operation.suggested_secret_keys.length > 0 ? (
                          <p className="mt-1 text-xs text-amber-200/80">
                            {t('agents.openApiSuggestedSecrets')}: {operation.suggested_secret_keys.join(', ')}
                          </p>
                        ) : null}
                        {operation.output_schema ? (
                          <p className="mt-1 text-xs text-emerald-200/80">{t('agents.openApiHasOutputSchema')}</p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => loadOpenApiOperation(operation)}
                        className="rounded-lg border border-indigo-500/30 px-3 py-1.5 text-xs text-indigo-100 hover:bg-indigo-500/10"
                      >
                        {t('agents.loadOperation')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </details>
      ) : null}

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
        <label className="space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-text-main">{t('agents.outputSchema')}</span>
          <textarea
            className={`${fieldClass} min-h-40 resize-y font-mono text-xs leading-5`}
            value={form.outputSchemaText}
            onChange={(event) => setForm((value) => ({ ...value, outputSchemaText: event.target.value }))}
            placeholder={t('agents.outputSchemaPlaceholder')}
          />
          <span className="block text-xs leading-5 text-text-muted">{t('agents.outputSchemaHint')}</span>
        </label>
      </section>

      {props.tool ? (
        <section className="space-y-4 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-sky-200">
                <Activity className="h-4 w-4" /> {t('agents.toolDiagnostics')}
              </div>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                {t('agents.toolDiagnosticsHint', { version: props.tool.tool_version })}
              </p>
            </div>
            <button
              type="button"
              disabled={Boolean(diagnosing)}
              onClick={() => void diagnose('preflight')}
              className="inline-flex items-center gap-2 rounded-lg border border-sky-500/30 px-3 py-2 text-xs text-sky-100 hover:bg-sky-500/10 disabled:opacity-50"
            >
              <Search className="h-3.5 w-3.5" />
              {diagnosing === 'preflight' ? t('agents.diagnosing') : t('agents.runPreflight')}
            </button>
          </div>

          {props.tool.kind === 'http' && props.tool.risk_level === 'read'
            && objectValue(props.tool.configuration).method === 'GET' ? (
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <label className="space-y-2">
                  <span className="text-xs font-medium text-text-main">{t('agents.safeTestInput')}</span>
                  <textarea
                    className={`${fieldClass} min-h-28 font-mono text-xs`}
                    value={testInputText}
                    onChange={(event) => setTestInputText(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={Boolean(diagnosing)}
                  onClick={() => void diagnose('safe_test')}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/30 px-3 py-2 text-xs text-emerald-100 hover:bg-emerald-500/10 disabled:opacity-50"
                >
                  <Activity className="h-3.5 w-3.5" />
                  {diagnosing === 'safe_test' ? t('agents.diagnosing') : t('agents.runSafeTest')}
                </button>
              </div>
            ) : props.tool.kind === 'http' ? (
              <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-100/90">
                {t('agents.writeTestBlocked')}
              </p>
            ) : (
              <button
                type="button"
                disabled={Boolean(diagnosing)}
                onClick={() => void diagnose('discover')}
                className="inline-flex items-center gap-2 rounded-lg border border-violet-500/30 px-3 py-2 text-xs text-violet-100 hover:bg-violet-500/10 disabled:opacity-50"
              >
                <Search className="h-3.5 w-3.5" />
                {diagnosing === 'discover' ? t('agents.diagnosing') : t('agents.discoverMcpTools')}
              </button>
            )}

          {diagnostic ? (
            <div className="space-y-3 border-t border-sky-500/15 pt-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {diagnostic.status === 'passed' ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                ) : (
                  <TriangleAlert className="h-4 w-4 text-red-300" />
                )}
                <span className={diagnostic.status === 'passed' ? 'text-emerald-200' : 'text-red-200'}>
                  {diagnostic.status === 'passed' ? t('agents.diagnosticPassed') : t('agents.diagnosticFailed')}
                </span>
                <span className="text-text-muted">· {diagnostic.duration_ms} ms · {diagnostic.live_request_attempted ? t('agents.liveRequestAttempted') : t('agents.noLiveRequest')}</span>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {diagnostic.checks.map((item) => (
                  <div key={item.key} className="rounded-lg border border-border bg-bg-base/60 px-3 py-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-text-main">{item.key}</span>
                      <span className={item.status === 'passed' ? 'text-emerald-300' : item.status === 'warning' ? 'text-amber-300' : 'text-red-300'}>{item.status}</span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-text-muted">{item.message}</p>
                  </div>
                ))}
              </div>
              {diagnostic.error ? (
                <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-200">
                  {diagnostic.error.code}: {diagnostic.error.message}
                </p>
              ) : null}
              {diagnostic.response ? (
                <div className="space-y-2">
                  <div className="text-xs text-text-muted">
                    HTTP {diagnostic.response.status} · {diagnostic.response.preview.original_bytes} bytes
                    {diagnostic.response.preview.truncated ? ` · ${t('agents.previewTruncated')}` : ''}
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-bg-base p-3 text-xs leading-5 text-text-main">{typeof diagnostic.response.preview.data === 'string'
                    ? diagnostic.response.preview.data
                    : JSON.stringify(diagnostic.response.preview.data, null, 2)}</pre>
                </div>
              ) : null}
              {diagnostic.discovery ? (
                <div className="space-y-2">
                  <p className="text-xs text-text-muted">
                    {diagnostic.discovery.server_info?.name || 'MCP'} · {diagnostic.discovery.protocol_version || 'unknown protocol'} · {diagnostic.discovery.tools.length} tools
                  </p>
                  {diagnostic.discovery.tools.map((tool) => (
                    <div key={tool.name} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-bg-base/60 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs text-text-main">{tool.name}</div>
                        <p className="mt-1 text-xs leading-5 text-text-muted">{tool.description || t('agents.noToolDescription')}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => importMcpTool(tool)}
                        className="rounded-lg border border-violet-500/30 px-3 py-1.5 text-xs text-violet-100 hover:bg-violet-500/10"
                      >
                        {t('agents.importMcpSchema')}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <AgentToolDiagnosticHistory
            toolId={props.tool.id}
            currentVersionId={props.tool.tool_version_id}
            revision={diagnosticHistoryRevision}
            onList={props.onListDiagnostics}
          />
        </section>
      ) : null}

      <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-200">
            <KeyRound className="h-4 w-4" /> {t('agents.credentials')}
          </div>
          {props.tool?.has_secrets ? (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200">
              {t('agents.credentialsConfigured', { version: props.tool.secret_version })}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs leading-5 text-text-muted">{t('agents.credentialsHint')}</p>
        {props.tool?.has_secrets ? (
          <p className="mt-2 text-xs leading-5 text-amber-100/80">{t('agents.credentialsReplaceHint')}</p>
        ) : null}
        <div className="mt-3 space-y-2">
          {form.secretRows.map((row) => (
            <div key={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <input
                className={`${fieldClass} font-mono text-xs`}
                value={row.key}
                disabled={form.clearSecrets}
                onChange={(event) => setForm((value) => ({
                  ...value,
                  clearSecrets: false,
                  secretRows: value.secretRows.map((candidate) => (
                    candidate.id === row.id ? { ...candidate, key: event.target.value } : candidate
                  )),
                }))}
                placeholder="bearer_token / header:X-Api-Key / query:tenant"
                aria-label={t('agents.credentialKey')}
              />
              <input
                className={`${fieldClass} font-mono text-xs`}
                type="password"
                autoComplete="new-password"
                value={row.value}
                disabled={form.clearSecrets}
                onChange={(event) => setForm((value) => ({
                  ...value,
                  clearSecrets: false,
                  secretRows: value.secretRows.map((candidate) => (
                    candidate.id === row.id ? { ...candidate, value: event.target.value } : candidate
                  )),
                }))}
                placeholder={t('agents.credentialValue')}
                aria-label={t('agents.credentialValue')}
              />
              <button
                type="button"
                disabled={form.clearSecrets || form.secretRows.length === 1}
                onClick={() => setForm((value) => ({
                  ...value,
                  secretRows: value.secretRows.filter((candidate) => candidate.id !== row.id),
                }))}
                className="grid h-10 w-10 place-items-center rounded-lg border border-border text-text-muted hover:bg-bg-surface disabled:opacity-40"
                aria-label={t('agents.removeCredential')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          disabled={form.clearSecrets || form.secretRows.length >= 32}
          onClick={() => setForm((value) => ({
            ...value,
            secretRows: [...value.secretRows, { id: crypto.randomUUID(), key: '', value: '' }],
          }))}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-500/30 px-3 py-2 text-xs text-amber-100 hover:bg-amber-500/10 disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" /> {t('agents.addCredential')}
        </button>
        {props.tool?.has_secrets ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-amber-500/15 pt-3">
            <label className="flex items-center gap-2 text-xs text-text-muted">
              <input
                type="checkbox"
                checked={form.clearSecrets}
                onChange={(event) => setForm((value) => ({ ...value, clearSecrets: event.target.checked }))}
                className="accent-primary"
              />
              {t('agents.clearCredentials')}
            </label>
            <button
              type="button"
              disabled={rotating || saving}
              onClick={() => void rotateSecrets()}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-text-main hover:bg-bg-surface disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${rotating ? 'animate-spin' : ''}`} />
              {t('agents.rotateCredentials')}
            </button>
          </div>
        ) : null}
      </section>
      {props.tool ? <AgentToolVersionHistory tool={props.tool} /> : null}
    </div>
  );
}

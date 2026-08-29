import { useEffect, useMemo, useState } from 'react';
import { Activity, Bot, Plus, Search, ShieldCheck, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import AgentEditor from '../features/agents/AgentEditor';
import AgentRunHistory from '../features/agents/AgentRunHistory';
import AgentApprovalInbox from '../features/agents/AgentApprovalInbox';
import ToolEditor from '../features/agents/ToolEditor';
import type { Agent, CustomAgentTool } from '../features/agents/types';
import { toSafeError } from '../lib/safeError';
import { useLocation } from '../lib/navigation';
import { useAgentStore } from '../stores/useAgentStore';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';

type Tab = 'agents' | 'tools' | 'approvals' | 'runs';

const statusClass: Record<Agent['status'], string> = {
  draft: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  published: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  disabled: 'border-border bg-bg-surface text-text-muted',
};

export default function AgentsPage() {
  const { t } = useTranslation();
  const { search: locationSearch } = useLocation();
  const requestedRunId = useMemo(() => {
    const value = new URLSearchParams(locationSearch).get('runId');
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  }, [locationSearch]);
  const { currentProjectSpaceId, projectSpaces } = useProjectSpaceStore(useShallow((state) => ({
    currentProjectSpaceId: state.currentProjectSpaceId,
    projectSpaces: state.projectSpaces,
  })));
  const {
    agents,
    collaboratorAgents,
    builtinTools,
    customTools,
    providerHealth,
    loading,
    fetchCatalog,
    createAgent,
    updateAgent,
    publishAgent,
    rollbackAgentVersion,
    duplicateAgent,
    setAgentDisabled,
    deleteAgent,
    createTool,
    updateTool,
    rotateToolSecrets,
    diagnoseTool,
    listToolDiagnostics,
    importOpenApi,
    deleteTool,
  } = useAgentStore(useShallow((state) => ({
    agents: state.agents,
    collaboratorAgents: state.collaboratorAgents,
    builtinTools: state.builtinTools,
    customTools: state.customTools,
    providerHealth: state.providerHealth,
    loading: state.loading,
    fetchCatalog: state.fetchCatalog,
    createAgent: state.createAgent,
    updateAgent: state.updateAgent,
    publishAgent: state.publishAgent,
    rollbackAgentVersion: state.rollbackAgentVersion,
    duplicateAgent: state.duplicateAgent,
    setAgentDisabled: state.setAgentDisabled,
    deleteAgent: state.deleteAgent,
    createTool: state.createTool,
    updateTool: state.updateTool,
    rotateToolSecrets: state.rotateToolSecrets,
    diagnoseTool: state.diagnoseTool,
    listToolDiagnostics: state.listToolDiagnostics,
    importOpenApi: state.importOpenApi,
    deleteTool: state.deleteTool,
  })));
  const [tab, setTab] = useState<Tab>(() => requestedRunId ? 'runs' : 'agents');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const catalogTab = tab === 'agents' || tab === 'tools';

  useEffect(() => {
    setSelectedAgentId(null);
    setSelectedToolId(null);
    setCreating(false);
  }, [currentProjectSpaceId]);

  useEffect(() => {
    if (!requestedRunId) return;
    setTab('runs');
    setCreating(false);
  }, [requestedRunId]);

  useEffect(() => {
    void fetchCatalog(currentProjectSpaceId).catch((error) => {
      console.error('Failed to load Agent catalog:', toSafeError(error));
      toast.error(t('agents.loadFailed'));
    });
  }, [currentProjectSpaceId, fetchCatalog, t]);

  const filteredAgents = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return agents;
    return agents.filter((agent) => `${agent.name} ${agent.description}`.toLocaleLowerCase().includes(needle));
  }, [agents, query]);
  const filteredTools = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return customTools;
    return customTools.filter((tool) => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(needle));
  }, [customTools, query]);

  const selectedAgent = selectedAgentId
    ? agents.find((agent) => agent.id === selectedAgentId) || null
    : null;
  const selectedTool = selectedToolId
    ? customTools.find((tool) => tool.id === selectedToolId) || null
    : null;
  const editorKey = tab === 'agents'
    ? `agent:${currentProjectSpaceId || 'global'}:${creating ? 'new' : selectedAgent?.id || 'empty'}:${selectedAgent?.version || 0}`
    : `tool:${currentProjectSpaceId || 'global'}:${creating ? 'new' : selectedTool?.id || 'empty'}:${selectedTool?.updated_at || ''}`;

  const selectAgent = (agent: Agent | null) => {
    setSelectedAgentId(agent?.id || null);
    setCreating(false);
  };
  const selectTool = (tool: CustomAgentTool | null) => {
    setSelectedToolId(tool?.id || null);
    setCreating(false);
  };

  const startCreate = () => {
    setCreating(true);
    if (tab === 'agents') setSelectedAgentId(null);
    else setSelectedToolId(null);
  };

  return (
    <div className="h-full overflow-y-auto bg-bg-base p-4 md:p-6">
      <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-text-main">{t('agents.title')}</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">{t('agents.subtitle')}</p>
          </div>
          {catalogTab ? (
            <button
              type="button"
              onClick={startCreate}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-primary-hover"
            >
              <Plus className="h-4 w-4" />
              {t(tab === 'agents' ? 'agents.createAgent' : 'agents.createTool')}
            </button>
          ) : null}
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-sidebar p-2">
          <div className="flex rounded-lg bg-bg-base p-1">
            <button
              type="button"
              onClick={() => { setTab('agents'); setCreating(false); }}
              className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm ${tab === 'agents' ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'}`}
            >
              <Bot className="h-4 w-4" /> {t('agents.agentsTab')}
            </button>
            <button
              type="button"
              onClick={() => { setTab('tools'); setCreating(false); }}
              className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm ${tab === 'tools' ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'}`}
            >
              <Wrench className="h-4 w-4" /> {t('agents.toolsTab')}
            </button>
            <button
              type="button"
              onClick={() => { setTab('approvals'); setCreating(false); }}
              className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm ${tab === 'approvals' ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'}`}
            >
              <ShieldCheck className="h-4 w-4" /> {t('agents.approvalsTab')}
            </button>
            <button
              type="button"
              onClick={() => { setTab('runs'); setCreating(false); }}
              className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm ${tab === 'runs' ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'}`}
            >
              <Activity className="h-4 w-4" /> {t('agents.runsTab')}
            </button>
          </div>
          {catalogTab ? (
            <label className="relative min-w-56 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg-base py-2 pl-9 pr-3 text-sm text-text-main outline-none focus:border-primary"
                placeholder={t('agents.searchPlaceholder')}
              />
            </label>
          ) : null}
        </div>

        <div className={!catalogTab ? 'min-h-[640px] flex-1' : 'grid min-h-[640px] flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]'}>
          {catalogTab ? <aside className="rounded-xl border border-border bg-bg-sidebar p-3">
            {loading ? <p className="px-2 py-6 text-center text-sm text-text-muted">{t('common.loading')}</p> : null}
            {!loading && tab === 'agents' ? (
              <div className="space-y-2">
                {filteredAgents.length === 0 ? <p className="px-2 py-8 text-center text-sm text-text-muted">{t('agents.noAgents')}</p> : null}
                {filteredAgents.map((agent) => (
                  <button
                    type="button"
                    key={agent.id}
                    onClick={() => selectAgent(agent)}
                    className={`w-full rounded-xl border p-3 text-left transition-colors ${selectedAgentId === agent.id && !creating ? 'border-primary/60 bg-primary/10' : 'border-border bg-bg-base hover:border-primary/30'}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-text-main">{agent.avatar || '🤖'} {agent.name}</span>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusClass[agent.status]}`}>{t(`agents.statuses.${agent.status}`)}</span>
                    </span>
                    <span className="mt-1 line-clamp-2 text-xs leading-5 text-text-muted">{agent.description || t('agents.noDescription')}</span>
                    <span className="mt-2 block text-[10px] text-text-muted">v{agent.version} · {agent.tool_bindings.filter((binding) => binding.enabled !== false).length} {t('agents.toolsCount')}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {!loading && tab === 'tools' ? (
              <div className="space-y-2">
                {filteredTools.length === 0 ? <p className="px-2 py-8 text-center text-sm text-text-muted">{t('agents.noCustomTools')}</p> : null}
                {filteredTools.map((tool) => (
                  <button
                    type="button"
                    key={tool.id}
                    onClick={() => selectTool(tool)}
                    className={`w-full rounded-xl border p-3 text-left transition-colors ${selectedToolId === tool.id && !creating ? 'border-primary/60 bg-primary/10' : 'border-border bg-bg-base hover:border-primary/30'}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-text-main">{tool.name}</span>
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">{tool.kind.toUpperCase()}</span>
                    </span>
                    <span className="mt-1 line-clamp-2 text-xs leading-5 text-text-muted">{tool.description || t('agents.noDescription')}</span>
                    <span className="mt-2 block text-[10px] text-text-muted">v{tool.tool_version ?? tool.latest_version ?? 1} · {tool.risk_level} · {tool.enabled ? t('agents.enabled') : t('agents.disabled')}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </aside> : null}

          <main className={!catalogTab ? 'min-h-[640px]' : 'rounded-xl border border-border bg-bg-sidebar p-4 md:p-6'}>
            {tab === 'agents' && (selectedAgent || creating) ? (
              <AgentEditor
                key={editorKey}
                agent={creating ? null : selectedAgent}
                projectSpaceId={currentProjectSpaceId}
                projectSpaces={projectSpaces}
                collaboratorAgents={collaboratorAgents}
                builtinTools={builtinTools}
                customTools={customTools}
                providerHealth={providerHealth}
                onCreate={createAgent}
                onUpdate={updateAgent}
                onPublish={publishAgent}
                onRollback={rollbackAgentVersion}
                onDuplicate={duplicateAgent}
                onDisable={setAgentDisabled}
                onDelete={deleteAgent}
                onSelected={selectAgent}
              />
            ) : null}
            {tab === 'tools' && (selectedTool || creating) ? (
              <ToolEditor
                key={editorKey}
                tool={creating ? null : selectedTool}
                projectSpaceId={currentProjectSpaceId}
                projectSpaces={projectSpaces}
                onCreate={createTool}
                onUpdate={updateTool}
                onRotateSecrets={rotateToolSecrets}
                onDiagnose={diagnoseTool}
                onListDiagnostics={listToolDiagnostics}
                onImportOpenApi={importOpenApi}
                onDelete={deleteTool}
                onSelected={selectTool}
              />
            ) : null}
            {tab === 'runs' ? (
              <AgentRunHistory agentId={selectedAgentId} initialRunId={requestedRunId} />
            ) : null}
            {tab === 'approvals' ? <AgentApprovalInbox /> : null}
            {!creating && tab === 'agents' && !selectedAgent ? (
              <div className="grid min-h-[520px] place-items-center text-center">
                <div className="max-w-md">
                  <Bot className="mx-auto h-10 w-10 text-primary" />
                  <h2 className="mt-4 text-lg font-semibold text-text-main">{t('agents.selectAgentTitle')}</h2>
                  <p className="mt-2 text-sm leading-6 text-text-muted">{t('agents.selectAgentHint')}</p>
                </div>
              </div>
            ) : null}
            {!creating && tab === 'tools' && !selectedTool ? (
              <div className="grid min-h-[520px] place-items-center text-center">
                <div className="max-w-md">
                  <Wrench className="mx-auto h-10 w-10 text-amber-300" />
                  <h2 className="mt-4 text-lg font-semibold text-text-main">{t('agents.selectToolTitle')}</h2>
                  <p className="mt-2 text-sm leading-6 text-text-muted">{t('agents.selectToolHint')}</p>
                </div>
              </div>
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}

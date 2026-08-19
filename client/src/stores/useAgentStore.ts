import { create } from 'zustand';
import api from '../lib/api';
import { RequestGenerationGuard } from './requestGeneration';
import type {
  Agent,
  AgentInput,
  BuiltinAgentTool,
  CustomAgentTool,
  CustomAgentToolInput,
  ProviderHealthResponse,
} from '../features/agents/types';
import { isRequestCancellation } from '../lib/requestCancellation';
import { toSafeError } from '../lib/safeError';
import { useChatStore } from './useChatStore';

interface AgentState {
  agents: Agent[];
  builtinTools: BuiltinAgentTool[];
  customTools: CustomAgentTool[];
  providerHealth: ProviderHealthResponse | null;
  loading: boolean;
  loadedProjectSpaceId: string | null | undefined;
  fetchCatalog: (projectSpaceId?: string | null, force?: boolean) => Promise<void>;
  createAgent: (input: AgentInput) => Promise<Agent>;
  updateAgent: (id: string, input: Partial<AgentInput>) => Promise<Agent>;
  publishAgent: (id: string) => Promise<Agent>;
  duplicateAgent: (id: string, name?: string) => Promise<Agent>;
  setAgentDisabled: (id: string, disabled: boolean) => Promise<Agent>;
  deleteAgent: (id: string) => Promise<void>;
  createTool: (input: CustomAgentToolInput) => Promise<CustomAgentTool>;
  updateTool: (id: string, input: Partial<CustomAgentToolInput>) => Promise<CustomAgentTool>;
  deleteTool: (id: string) => Promise<void>;
  reset: () => void;
}

const catalogGuard = new RequestGenerationGuard();
let catalogMutationGeneration = 0;

/**
 * The catalog endpoint returns global resources plus resources pinned to the
 * requested project space. Mutations return the authoritative resource, so we
 * must apply the same visibility rule when updating the in-memory catalog;
 * otherwise a resource moved to another workspace remains visible until the
 * next fetch.
 */
export const isAgentCatalogResourceVisible = (
  resourceProjectSpaceId: string | null | undefined,
  catalogProjectSpaceId: string | null | undefined,
) => catalogProjectSpaceId == null
  || resourceProjectSpaceId == null
  || resourceProjectSpaceId === catalogProjectSpaceId;

const initialState = {
  agents: [] as Agent[],
  builtinTools: [] as BuiltinAgentTool[],
  customTools: [] as CustomAgentTool[],
  providerHealth: null as ProviderHealthResponse | null,
  loading: false,
  loadedProjectSpaceId: undefined as string | null | undefined,
};

export const useAgentStore = create<AgentState>((set, get) => ({
  ...initialState,

  fetchCatalog: async (projectSpaceId, force = false) => {
    if (!force && get().loadedProjectSpaceId === projectSpaceId) return;
    const ticket = catalogGuard.begin('agent-catalog');
    const mutationGeneration = catalogMutationGeneration;
    set({ loading: true });
    const params = projectSpaceId ? { projectSpaceId, includeDisabled: true } : { includeDisabled: true };
    try {
      const results = await Promise.allSettled([
        api.get<Agent[]>('/agents', { params, signal: ticket.controller.signal }),
        api.get<BuiltinAgentTool[]>('/agents/tools/catalog', { signal: ticket.controller.signal }),
        api.get<CustomAgentTool[]>('/agent-tools', { params, signal: ticket.controller.signal }),
        api.get<ProviderHealthResponse>('/usage/provider-health', { signal: ticket.controller.signal }),
      ]);
      if (!catalogGuard.isCurrent(ticket)) return;
      const [agentsResult, builtinResult, customToolsResult, providerResult] = results;
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      const isCancelled = rejected.every((result) => isRequestCancellation(result.reason));
      if (isCancelled && rejected.length > 0) return;
      const catalogUnavailable = agentsResult.status === 'rejected'
        && customToolsResult.status === 'rejected';
      if (catalogUnavailable) {
        throw agentsResult.reason;
      }
      if (mutationGeneration !== catalogMutationGeneration) {
        // A catalog response that started before a successful mutation may
        // contain stale rows. Re-read the same scope before publishing it.
        await get().fetchCatalog(projectSpaceId, true);
        return;
      }
      set({
        agents: agentsResult.status === 'fulfilled' ? agentsResult.value.data : [],
        builtinTools: builtinResult.status === 'fulfilled' ? builtinResult.value.data : [],
        customTools: customToolsResult.status === 'fulfilled' ? customToolsResult.value.data : [],
        providerHealth: providerResult.status === 'fulfilled' ? providerResult.value.data : null,
        loadedProjectSpaceId: projectSpaceId,
      });
      if (rejected.length > 0 && !isCancelled) {
        console.warn(
          'Agent catalog partially unavailable',
          rejected.map((result) => toSafeError(result.reason)),
        );
      }
    } catch (error) {
      if (!isRequestCancellation(error)) {
        if (catalogGuard.isCurrent(ticket)) {
          set({ agents: [], builtinTools: [], customTools: [], providerHealth: null, loadedProjectSpaceId: undefined });
        }
        throw error;
      }
    } finally {
      if (catalogGuard.finish(ticket)) set({ loading: false });
    }
  },

  createAgent: async (input) => {
    const { data } = await api.post<Agent>('/agents', input);
    catalogMutationGeneration += 1;
    set((state) => {
      const visible = isAgentCatalogResourceVisible(data.project_space_id, state.loadedProjectSpaceId);
      return {
        agents: visible
          ? [data, ...state.agents.filter((agent) => agent.id !== data.id)]
          : state.agents.filter((agent) => agent.id !== data.id),
      };
    });
    return data;
  },

  updateAgent: async (id, input) => {
    const { data } = await api.patch<Agent>(`/agents/${id}`, input);
    catalogMutationGeneration += 1;
    set((state) => {
      const visible = isAgentCatalogResourceVisible(data.project_space_id, state.loadedProjectSpaceId);
      return {
        agents: visible
          ? state.agents.map((agent) => agent.id === id ? data : agent)
          : state.agents.filter((agent) => agent.id !== id),
      };
    });
    void useChatStore.getState().fetchConversations();
    return data;
  },

  publishAgent: async (id) => {
    const { data } = await api.post<Agent>(`/agents/${id}/publish`, {});
    catalogMutationGeneration += 1;
    set((state) => ({
      agents: isAgentCatalogResourceVisible(data.project_space_id, state.loadedProjectSpaceId)
        ? state.agents.map((agent) => agent.id === id ? data : agent)
        : state.agents.filter((agent) => agent.id !== id),
    }));
    void useChatStore.getState().fetchConversations();
    return data;
  },

  duplicateAgent: async (id, name) => {
    const { data } = await api.post<Agent>(`/agents/${id}/duplicate`, name ? { name } : {});
    catalogMutationGeneration += 1;
    set((state) => ({
      agents: isAgentCatalogResourceVisible(data.project_space_id, state.loadedProjectSpaceId)
        ? [data, ...state.agents.filter((agent) => agent.id !== data.id)]
        : state.agents.filter((agent) => agent.id !== data.id),
    }));
    return data;
  },

  setAgentDisabled: async (id, disabled) => {
    const { data } = await api.patch<Agent>(`/agents/${id}/status`, { disabled });
    catalogMutationGeneration += 1;
    set((state) => ({
      agents: isAgentCatalogResourceVisible(data.project_space_id, state.loadedProjectSpaceId)
        ? state.agents.map((agent) => agent.id === id ? data : agent)
        : state.agents.filter((agent) => agent.id !== id),
    }));
    void useChatStore.getState().fetchConversations();
    return data;
  },

  deleteAgent: async (id) => {
    await api.delete(`/agents/${id}`);
    catalogMutationGeneration += 1;
    set((state) => ({ agents: state.agents.filter((agent) => agent.id !== id) }));
    void useChatStore.getState().fetchConversations();
  },

  createTool: async (input) => {
    const { data } = await api.post<CustomAgentTool>('/agent-tools', input);
    catalogMutationGeneration += 1;
    set((state) => ({
      customTools: isAgentCatalogResourceVisible(data.project_space_id, state.loadedProjectSpaceId)
        ? [data, ...state.customTools.filter((tool) => tool.id !== data.id)]
        : state.customTools.filter((tool) => tool.id !== data.id),
    }));
    return data;
  },

  updateTool: async (id, input) => {
    const { data } = await api.patch<CustomAgentTool>(`/agent-tools/${id}`, input);
    catalogMutationGeneration += 1;
    set((state) => ({
      customTools: isAgentCatalogResourceVisible(data.project_space_id, state.loadedProjectSpaceId)
        ? state.customTools.map((tool) => tool.id === id ? data : tool)
        : state.customTools.filter((tool) => tool.id !== id),
    }));
    return data;
  },

  deleteTool: async (id) => {
    await api.delete(`/agent-tools/${id}`);
    catalogMutationGeneration += 1;
    set((state) => ({ customTools: state.customTools.filter((tool) => tool.id !== id) }));
  },

  reset: () => {
    catalogGuard.abort('agent-catalog');
    catalogMutationGeneration += 1;
    set(initialState);
  },
}));

import { beforeEach, describe, expect, test, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../lib/api', () => ({ default: apiMock }));

import { isAgentCatalogResourceVisible, useAgentStore } from './useAgentStore';
import { memoryPolicyFromPreset } from '../features/agents/agentMemoryPolicy';
import type { CustomAgentTool } from '../features/agents/types';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const agent = (id: string, project_space_id: string | null) => ({
  id,
  user_id: 'user-1',
  project_space_id,
  name: id,
  description: '',
  avatar: '',
  visibility: 'private' as const,
  status: 'published' as const,
  current_version_id: 'version-1',
  published_version_id: 'version-1',
  latest_version: 1,
  version: 1,
  configuration_hash: 'a'.repeat(64),
  derived_from_version_id: null,
  change_kind: 'created' as const,
  published_version: 1,
  has_unpublished_changes: false,
  instructions: 'help',
  model: 'qwen-plus',
  temperature: 0.7,
  max_iterations: 2,
  max_duration_ms: 120000,
  max_output_tokens: 512,
  memory_mode: 'none' as const,
  memory_policy: memoryPolicyFromPreset('none'),
  response_format: 'markdown' as const,
  output_schema: {},
  approval_policy: 'never' as const,
  tool_bindings: [],
  delegation_mode: 'explicit' as const,
  delegation_bindings: [],
  welcome_message: '',
  suggested_prompts: [],
  created_at: '',
  updated_at: '',
});

const customTool = (secretVersion: number): CustomAgentTool => ({
  id: '22222222-2222-4222-8222-222222222222',
  user_id: 'user-1',
  project_space_id: 'space-a',
  name: 'Weather',
  description: '',
  kind: 'http',
  risk_level: 'read',
  max_invocations_per_run: null,
  configuration: {},
  enabled: true,
  has_secrets: true,
  current_version_id: `version-${secretVersion}`,
  latest_version: secretVersion,
  tool_version_id: `version-${secretVersion}`,
  tool_version: secretVersion,
  secret_version: secretVersion,
  configuration_hash: 'a'.repeat(64),
  derived_from_version_id: null,
  change_kind: 'secret_rotated',
  created_at: '',
  updated_at: String(secretVersion),
  tool_version_created_at: '',
});

beforeEach(() => {
  vi.clearAllMocks();
  useAgentStore.getState().reset();
});

describe('Agent catalog project-space visibility', () => {
  test('keeps global resources visible in a scoped catalog', () => {
    expect(isAgentCatalogResourceVisible(null, 'space-a')).toBe(true);
    expect(isAgentCatalogResourceVisible(undefined, 'space-a')).toBe(true);
  });

  test('keeps all resources when the catalog has no project-space filter', () => {
    expect(isAgentCatalogResourceVisible('space-a', null)).toBe(true);
    expect(isAgentCatalogResourceVisible('space-a', undefined)).toBe(true);
  });

  test('removes resources pinned to a different project space', () => {
    expect(isAgentCatalogResourceVisible('space-a', 'space-b')).toBe(false);
    expect(isAgentCatalogResourceVisible('space-a', 'space-a')).toBe(true);
  });

  test('re-reads a catalog response that raced with a successful mutation', async () => {
    const stale = deferred<{ data: ReturnType<typeof agent>[] }>();
    const created = agent('created', 'space-a');
    let agentListCalls = 0;
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/agents') {
        agentListCalls += 1;
        return agentListCalls === 1
          ? stale.promise
          : Promise.resolve({ data: [created] });
      }
      if (url === '/agents/tools/catalog') return Promise.resolve({ data: [] });
      if (url === '/agent-tools') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: { default_model: 'qwen-plus', providers: [] } });
    });
    apiMock.post.mockResolvedValue({ data: created });

    const fetching = useAgentStore.getState().fetchCatalog('space-a', true);
    await useAgentStore.getState().createAgent({ name: 'created', instructions: 'help' });
    stale.resolve({ data: [] });
    await fetching;

    expect(agentListCalls).toBe(4);
    expect(useAgentStore.getState().agents.map((item) => item.id)).toEqual(['created']);
    expect(useAgentStore.getState().collaboratorAgents.map((item) => item.id)).toEqual(['created']);
  });
});

describe('Agent version governance mutations', () => {
  test('publishes release notes and applies the authoritative Agent response', async () => {
    const current = {
      ...agent('governed', 'space-a'),
      status: 'draft' as const,
      published_version_id: null,
      published_version: null,
      has_unpublished_changes: true,
    };
    const published = {
      ...current,
      status: 'published' as const,
      published_version_id: current.current_version_id,
      published_version: current.version,
      has_unpublished_changes: false,
    };
    useAgentStore.setState({ agents: [current], loadedProjectSpaceId: 'space-a' });
    apiMock.post.mockResolvedValue({ data: published });
    apiMock.get.mockResolvedValue({ data: [], headers: {} });

    await useAgentStore.getState().publishAgent(current.id, 'Validated RAG citations.');

    expect(apiMock.post).toHaveBeenCalledWith(`/agents/${current.id}/publish`, {
      release_notes: 'Validated RAG citations.',
    });
    expect(useAgentStore.getState().agents[0]).toEqual(published);
  });

  test('rolls back through the copy endpoint and keeps the new monotonic version', async () => {
    const current = agent('governed', 'space-a');
    const rolledBack = {
      ...current,
      current_version_id: 'version-2',
      latest_version: 2,
      version: 2,
      configuration_hash: 'b'.repeat(64),
      derived_from_version_id: 'version-1',
      change_kind: 'rollback' as const,
      has_unpublished_changes: true,
    };
    useAgentStore.setState({ agents: [current], loadedProjectSpaceId: 'space-a' });
    apiMock.post.mockResolvedValue({ data: rolledBack });
    apiMock.get.mockResolvedValue({ data: [], headers: {} });

    const result = await useAgentStore.getState().rollbackAgentVersion(
      current.id,
      'version-1',
    );

    expect(apiMock.post).toHaveBeenCalledWith(
      `/agents/${current.id}/versions/version-1/rollback`,
      {},
    );
    expect(result.version).toBe(2);
    expect(result.change_kind).toBe('rollback');
    expect(useAgentStore.getState().agents[0]).toEqual(rolledBack);
  });
});

describe('Agent tool Secret lifecycle mutations', () => {
  test('applies the immutable tool version returned by key rotation', async () => {
    const current = customTool(1);
    const rotated = customTool(2);
    useAgentStore.setState({ customTools: [current], loadedProjectSpaceId: 'space-a' });
    apiMock.post.mockResolvedValue({ data: rotated });

    const result = await useAgentStore.getState().rotateToolSecrets(current.id);

    expect(apiMock.post).toHaveBeenCalledWith(
      `/agent-tools/${current.id}/secrets/rotate`,
      {},
    );
    expect(result.secret_version).toBe(2);
    expect(useAgentStore.getState().customTools).toEqual([rotated]);
  });
});

describe('Agent tool diagnostics', () => {
  test('posts an explicit bounded diagnostic operation without mutating the catalog', async () => {
    const current = customTool(1);
    const diagnostic = {
      tool_id: current.id,
      tool_version_id: current.tool_version_id,
      configuration_hash: current.configuration_hash,
      operation: 'safe_test' as const,
      status: 'passed' as const,
      live_request_attempted: true,
      checked_at: '',
      duration_ms: 12,
      input_hash: 'b'.repeat(64),
      checks: [],
    };
    useAgentStore.setState({ customTools: [current], loadedProjectSpaceId: 'space-a' });
    apiMock.post.mockResolvedValue({ data: diagnostic });

    const result = await useAgentStore.getState().diagnoseTool(current.id, {
      operation: 'safe_test',
      input: { city: 'Shanghai' },
    });

    expect(apiMock.post).toHaveBeenCalledWith(
      `/agent-tools/${current.id}/diagnostics`,
      { operation: 'safe_test', input: { city: 'Shanghai' } },
    );
    expect(result).toEqual(diagnostic);
    expect(useAgentStore.getState().customTools).toEqual([current]);
  });

  test('lists immutable diagnostic history with an explicit stable cursor', async () => {
    const current = customTool(1);
    const page = {
      items: [{
        id: '55555555-5555-4555-8555-555555555555',
        tool_id: current.id,
        tool_version_id: current.tool_version_id,
        configuration_hash: current.configuration_hash,
        operation: 'preflight' as const,
        status: 'passed' as const,
        live_request_attempted: false,
        passed_check_count: 6,
        warning_check_count: 0,
        failed_check_count: 0,
        error_code: null,
        response_status: null,
        discovery_tool_count: null,
        discovery_warning_count: null,
        duration_ms: 8,
        checked_at: '2026-08-29T08:09:10.123Z',
        created_at: '2026-08-29T08:09:10.124Z',
      }],
      next_cursor: 'opaque-cursor',
    };
    apiMock.get.mockResolvedValue({ data: page });

    const result = await useAgentStore.getState().listToolDiagnostics(current.id, {
      operation: 'preflight',
      limit: 10,
      cursor: 'previous-cursor',
    });

    expect(apiMock.get).toHaveBeenCalledWith(
      `/agent-tools/${current.id}/diagnostics`,
      { params: { operation: 'preflight', limit: 10, cursor: 'previous-cursor' } },
    );
    expect(result).toEqual(page);
  });
});

describe('OpenAPI tool import', () => {
  test('submits a document for deterministic parsing without changing tool state', async () => {
    const current = customTool(1);
    const imported = {
      title: 'Weather API',
      version: '3.1.0',
      operations: [],
      warnings: [],
      truncated: false,
    };
    useAgentStore.setState({ customTools: [current] });
    apiMock.post.mockResolvedValue({ data: imported });
    const document = { openapi: '3.1.0', info: {}, paths: {} };

    const result = await useAgentStore.getState().importOpenApi({
      document,
      base_url: 'https://api.example.com',
    });

    expect(apiMock.post).toHaveBeenCalledWith('/agent-tools/imports/openapi', {
      document,
      base_url: 'https://api.example.com',
    });
    expect(result).toEqual(imported);
    expect(useAgentStore.getState().customTools).toEqual([current]);
  });
});

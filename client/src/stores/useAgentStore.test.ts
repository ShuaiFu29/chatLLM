import { beforeEach, describe, expect, test, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../lib/api', () => ({ default: apiMock }));

import { isAgentCatalogResourceVisible, useAgentStore } from './useAgentStore';

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
  published_version: 1,
  has_unpublished_changes: false,
  instructions: 'help',
  model: 'qwen-plus',
  temperature: 0.7,
  max_iterations: 2,
  max_duration_ms: 120000,
  max_output_tokens: 512,
  memory_mode: 'none' as const,
  response_format: 'markdown' as const,
  output_schema: {},
  approval_policy: 'never' as const,
  tool_bindings: [],
  welcome_message: '',
  suggested_prompts: [],
  created_at: '',
  updated_at: '',
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

    expect(agentListCalls).toBe(2);
    expect(useAgentStore.getState().agents.map((item) => item.id)).toEqual(['created']);
  });
});

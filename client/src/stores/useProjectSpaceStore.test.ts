import { beforeAll, beforeEach, expect, test, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../lib/api', () => ({ default: apiMock }));

const storage = new Map<string, string>();
let useProjectSpaceStore: typeof import('./useProjectSpaceStore')['useProjectSpaceStore'];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const space = (id: string, name: string) => ({
  id,
  user_id: 'user-id',
  name,
  description: '',
  is_default: id === 'space-a',
  created_at: '2026-07-13T00:00:00.000Z',
  updated_at: '2026-07-13T00:00:00.000Z',
});

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => storage.get(key) || null),
    setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn((key: string) => { storage.delete(key); }),
  });
  ({ useProjectSpaceStore } = await import('./useProjectSpaceStore'));
});

beforeEach(() => {
  storage.clear();
  vi.clearAllMocks();
  useProjectSpaceStore.setState({
    projectSpaces: [],
    currentProjectSpaceId: null,
    loadingProjectSpaces: false,
  });
});

test('latest project-space fetch wins when responses arrive out of order', async () => {
  const first = deferred<{ data: ReturnType<typeof space>[] }>();
  const second = deferred<{ data: ReturnType<typeof space>[] }>();
  apiMock.get
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);

  const olderFetch = useProjectSpaceStore.getState().fetchProjectSpaces();
  const newerFetch = useProjectSpaceStore.getState().fetchProjectSpaces();
  second.resolve({ data: [space('space-b', 'new list')] });
  await newerFetch;
  first.resolve({ data: [space('space-a', 'stale list')] });
  await olderFetch;

  expect(apiMock.get.mock.calls[0][1].signal.aborted).toBe(true);
  expect(useProjectSpaceStore.getState().projectSpaces.map((item) => item.name)).toEqual(['new list']);
  expect(useProjectSpaceStore.getState().currentProjectSpaceId).toBe('space-b');
});

test('failed rename refetches authoritative state instead of restoring an obsolete array snapshot', async () => {
  const renameRequest = deferred<never>();
  const authoritative = [
    space('space-a', 'server A'),
    space('space-b', 'concurrent B'),
    space('space-c', 'concurrent C'),
  ];
  apiMock.patch.mockImplementation(() => renameRequest.promise);
  apiMock.get.mockResolvedValue({ data: authoritative });
  useProjectSpaceStore.setState({
    projectSpaces: [space('space-a', 'old A'), space('space-b', 'old B')],
    currentProjectSpaceId: 'space-a',
  });

  const rename = useProjectSpaceStore.getState().renameProjectSpace('space-a', 'optimistic A');
  useProjectSpaceStore.setState((state) => ({
    projectSpaces: [...state.projectSpaces, space('space-c', 'local C')],
  }));
  renameRequest.reject(new Error('rename failed'));
  await expect(rename).rejects.toThrow('rename failed');

  expect(apiMock.get).toHaveBeenCalledTimes(1);
  expect(useProjectSpaceStore.getState().projectSpaces).toEqual(authoritative);
});

test('failed delete refetches authoritative state without reverting a newer selection', async () => {
  const deleteRequest = deferred<never>();
  const authoritative = [space('space-a', 'server A'), space('space-b', 'server B')];
  apiMock.delete.mockImplementation(() => deleteRequest.promise);
  apiMock.get.mockResolvedValue({ data: authoritative });
  useProjectSpaceStore.setState({
    projectSpaces: authoritative,
    currentProjectSpaceId: 'space-a',
  });

  const deletion = useProjectSpaceStore.getState().deleteProjectSpace('space-a');
  useProjectSpaceStore.getState().selectProjectSpace('space-b');
  deleteRequest.reject(new Error('delete failed'));
  await expect(deletion).rejects.toThrow('delete failed');

  expect(apiMock.get).toHaveBeenCalledTimes(1);
  expect(useProjectSpaceStore.getState().currentProjectSpaceId).toBe('space-b');
  expect(useProjectSpaceStore.getState().projectSpaces).toEqual(authoritative);
});

test('a successful mutation clears loading when it invalidates an in-flight list request', async () => {
  const listRequest = deferred<{ data: ReturnType<typeof space>[] }>();
  apiMock.get.mockImplementation(() => listRequest.promise);
  apiMock.patch.mockResolvedValue({ data: space('space-a', 'renamed A') });
  useProjectSpaceStore.setState({
    projectSpaces: [space('space-a', 'old A')],
    currentProjectSpaceId: 'space-a',
  });

  const listFetch = useProjectSpaceStore.getState().fetchProjectSpaces();
  await useProjectSpaceStore.getState().renameProjectSpace('space-a', 'renamed A');
  expect(useProjectSpaceStore.getState().loadingProjectSpaces).toBe(false);

  listRequest.resolve({ data: [space('space-a', 'stale A')] });
  await listFetch;
  expect(useProjectSpaceStore.getState().projectSpaces[0].name).toBe('renamed A');
});

test('successful rename fences a list request that started while the mutation was pending', async () => {
  const renameRequest = deferred<{ data: ReturnType<typeof space> }>();
  const listRequest = deferred<{ data: ReturnType<typeof space>[] }>();
  apiMock.patch.mockImplementation(() => renameRequest.promise);
  apiMock.get.mockImplementation(() => listRequest.promise);
  useProjectSpaceStore.setState({
    projectSpaces: [space('space-a', 'old A')],
    currentProjectSpaceId: 'space-a',
  });

  const rename = useProjectSpaceStore.getState().renameProjectSpace('space-a', 'renamed A');
  const listFetch = useProjectSpaceStore.getState().fetchProjectSpaces();
  renameRequest.resolve({ data: space('space-a', 'renamed A') });
  await rename;

  expect(apiMock.get.mock.calls[0][1].signal.aborted).toBe(true);
  listRequest.resolve({ data: [space('space-a', 'stale A')] });
  await listFetch;
  expect(useProjectSpaceStore.getState().projectSpaces[0].name).toBe('renamed A');
});

test('successful delete removes a record restored by a list response during the mutation', async () => {
  const deleteRequest = deferred<void>();
  const listRequest = deferred<{ data: ReturnType<typeof space>[] }>();
  apiMock.delete.mockImplementation(() => deleteRequest.promise);
  apiMock.get.mockImplementation(() => listRequest.promise);
  useProjectSpaceStore.setState({
    projectSpaces: [space('space-a', 'A'), space('space-b', 'B')],
    currentProjectSpaceId: 'space-b',
  });

  const deletion = useProjectSpaceStore.getState().deleteProjectSpace('space-a');
  const listFetch = useProjectSpaceStore.getState().fetchProjectSpaces();
  listRequest.resolve({ data: [space('space-a', 'stale A'), space('space-b', 'B')] });
  await listFetch;
  expect(useProjectSpaceStore.getState().projectSpaces.some((item) => item.id === 'space-a')).toBe(true);

  deleteRequest.resolve();
  await deletion;
  expect(useProjectSpaceStore.getState().projectSpaces.some((item) => item.id === 'space-a')).toBe(false);
  expect(useProjectSpaceStore.getState().currentProjectSpaceId).toBe('space-b');
});

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { KnowledgeFile } from './useKnowledgeFilesStore';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
}));
vi.mock('../lib/api', () => ({ default: apiMock }));

import { useKnowledgeFilesStore } from './useKnowledgeFilesStore';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const file = (id: string, status: KnowledgeFile['status']): KnowledgeFile => ({
  id,
  filename: `${id}.md`,
  status,
  progress: status === 'completed' ? 100 : 20,
  created_at: '2026-07-28T00:00:00.000Z',
});

beforeEach(() => {
  useKnowledgeFilesStore.getState().reset();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

test('simultaneous consumers share one files request and reuse the fresh result', async () => {
  const request = deferred<{ data: KnowledgeFile[] }>();
  apiMock.get.mockImplementation(() => request.promise);

  const first = useKnowledgeFilesStore.getState().fetchFiles('space-a');
  const second = useKnowledgeFilesStore.getState().fetchFiles('space-a');

  expect(first).toBe(second);
  expect(apiMock.get).toHaveBeenCalledTimes(1);
  request.resolve({ data: [file('file-a', 'completed')] });
  await Promise.all([first, second]);

  await useKnowledgeFilesStore.getState().fetchFiles('space-a');
  expect(apiMock.get).toHaveBeenCalledTimes(1);
  expect(useKnowledgeFilesStore.getState().files).toEqual([file('file-a', 'completed')]);
});

test('switching workspaces aborts stale work and only publishes the current response', async () => {
  const first = deferred<{ data: KnowledgeFile[] }>();
  const second = deferred<{ data: KnowledgeFile[] }>();
  apiMock.get
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);

  const staleFetch = useKnowledgeFilesStore.getState().fetchFiles('space-a');
  const currentFetch = useKnowledgeFilesStore.getState().fetchFiles('space-b');
  expect(apiMock.get.mock.calls[0][1].signal.aborted).toBe(true);

  second.resolve({ data: [file('file-b', 'completed')] });
  await currentFetch;
  first.resolve({ data: [file('file-a', 'completed')] });
  await staleFetch;

  expect(useKnowledgeFilesStore.getState().projectSpaceId).toBe('space-b');
  expect(useKnowledgeFilesStore.getState().files).toEqual([file('file-b', 'completed')]);
});

test('shared polling runs only while the current workspace has active files', async () => {
  vi.useFakeTimers();
  apiMock.get
    .mockResolvedValueOnce({ data: [file('file-a', 'processing')] })
    .mockResolvedValueOnce({ data: [file('file-a', 'completed')] });

  await useKnowledgeFilesStore.getState().fetchFiles('space-a');
  useKnowledgeFilesStore.getState().startPolling('space-a');

  await vi.advanceTimersByTimeAsync(3_000);
  expect(apiMock.get).toHaveBeenCalledTimes(2);
  expect(useKnowledgeFilesStore.getState().files[0].status).toBe('completed');

  await vi.advanceTimersByTimeAsync(6_000);
  expect(apiMock.get).toHaveBeenCalledTimes(2);
});

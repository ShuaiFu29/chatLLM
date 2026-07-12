import { beforeEach, expect, test, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../lib/api', () => ({ default: apiMock }));

import { useSearchStore } from './useSearchStore';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  useSearchStore.setState({
    query: '',
    results: [],
    isLoading: false,
    filters: {
      projectSpaceId: '',
      hasSources: false,
      model: '',
      favoriteOnly: false,
      tag: '',
      includeArchived: false,
    },
  });
});

test('latest search wins when an older response resolves last', async () => {
  const first = deferred<{ data: Array<{ id: string }> }>();
  const second = deferred<{ data: Array<{ id: string }> }>();
  apiMock.get
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);

  const olderSearch = useSearchStore.getState().searchMessages('older');
  const newerSearch = useSearchStore.getState().searchMessages('newer');

  second.resolve({ data: [{ id: 'new-result' }] });
  await newerSearch;
  first.resolve({ data: [{ id: 'old-result' }] });
  await olderSearch;

  expect(apiMock.get.mock.calls[0][1].signal.aborted).toBe(true);
  expect(useSearchStore.getState().results.map((result) => result.id)).toEqual(['new-result']);
  expect(useSearchStore.getState().isLoading).toBe(false);
});

test('changing the query invalidates an in-flight search before the next debounce fires', async () => {
  const pending = deferred<{ data: Array<{ id: string }> }>();
  apiMock.get.mockImplementation(() => pending.promise);

  const search = useSearchStore.getState().searchMessages('old query');
  useSearchStore.getState().setQuery('new query');
  pending.resolve({ data: [{ id: 'stale-result' }] });
  await search;

  expect(useSearchStore.getState().results).toEqual([]);
  expect(useSearchStore.getState().isLoading).toBe(false);
});

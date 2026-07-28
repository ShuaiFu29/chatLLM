import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, test, vi } from 'vitest';
import api, { authenticatedFetch } from './api';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const axiosResponse = (
  config: InternalAxiosRequestConfig,
  status: number,
): AxiosResponse => ({
  config,
  data: { ok: status < 400 },
  headers: {},
  status,
  statusText: status === 401 ? 'Unauthorized' : 'OK',
});

const rejectUnauthorized = (config: InternalAxiosRequestConfig) => Promise.reject({
  config,
  response: axiosResponse(config, 401),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared authentication refresh', () => {
  test.each(['/auth/login', '/auth/register'])('%s does not refresh after a credential rejection', async (url) => {
    const refresh = vi.spyOn(api, 'post');
    const adapter = vi.fn((config: InternalAxiosRequestConfig) => rejectUnauthorized(config));

    await expect(api.post(url, {}, { adapter })).rejects.toMatchObject({
      response: { status: 401 },
    });

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('fetch does not refresh or retry a login rejection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.spyOn(api, 'post').mockResolvedValue({} as AxiosResponse);

    const response = await authenticatedFetch('/api/auth/login?source=form', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  test('fetch preserves its options and refreshes and retries a 401 only once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401, statusText: 'Unauthorized' }))
      .mockResolvedValueOnce(new Response(null, { status: 401, statusText: 'Unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.spyOn(api, 'post').mockResolvedValue({} as AxiosResponse);
    const controller = new AbortController();
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test': 'preserved' },
      credentials: 'include',
      body: JSON.stringify({ content: 'hello' }),
      cache: 'no-store',
      signal: controller.signal,
    };

    const response = await authenticatedFetch('/api/chat/conversations/one/messages', init);

    expect(response.status).toBe(401);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual(['/api/chat/conversations/one/messages', init]);
    expect(fetchMock.mock.calls[1]).toEqual(['/api/chat/conversations/one/messages', init]);
    expect(fetchMock.mock.calls[1][1]).toBe(init);
  });

  test('Axios and fetch wait on the same in-flight refresh', async () => {
    const refresh = deferred<AxiosResponse>();
    const refreshSpy = vi.spyOn(api, 'post').mockImplementation(() => refresh.promise);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response('stream', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    let axiosAttempts = 0;
    const adapter = vi.fn(async (
      config: InternalAxiosRequestConfig,
    ): Promise<AxiosResponse> => {
      axiosAttempts += 1;
      if (axiosAttempts === 1) return rejectUnauthorized(config);
      return axiosResponse(config, 200);
    });

    const axiosRequest = api.get('/protected', { adapter });
    const fetchRequest = authenticatedFetch('/api/chat/conversations/one/messages', {
      credentials: 'include',
    });
    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));

    refresh.resolve({} as AxiosResponse);
    const [axiosResult, fetchResult] = await Promise.all([axiosRequest, fetchRequest]);

    expect(axiosResult.status).toBe(200);
    expect(fetchResult.status).toBe(200);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('Axios retries a persistent 401 once without starting a second refresh', async () => {
    const refreshSpy = vi.spyOn(api, 'post').mockResolvedValue({} as AxiosResponse);
    const adapter = vi.fn((config: InternalAxiosRequestConfig) => rejectUnauthorized(config));

    await expect(api.get('/protected', { adapter })).rejects.toMatchObject({
      response: { status: 401 },
    });

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  test('aborting while queued for refresh rejects promptly without retrying fetch', async () => {
    const refresh = deferred<AxiosResponse>();
    const refreshSpy = vi.spyOn(api, 'post').mockImplementation(() => refresh.promise);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const request = authenticatedFetch('/api/chat/conversations/one/messages', {
      credentials: 'include',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    refresh.resolve({} as AxiosResponse);
    await refresh.promise;
    await Promise.resolve();
  });
});

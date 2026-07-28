import axios, {
  type AxiosError,
  type InternalAxiosRequestConfig,
} from 'axios';

const api = axios.create({
  baseURL: '/api', // Vite proxy will handle this
  withCredentials: true, // Important for Cookies
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 60000, // 60s timeout
});

interface RetryableAxiosRequestConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

let refreshPromise: Promise<void> | null = null;

const isAuthBootstrapRequest = (input: RequestInfo | URL | string) => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  return /\/auth\/(?:refresh|login|register)(?:[/?#]|$)/.test(url);
};

const refreshAccessToken = () => {
  if (refreshPromise) return refreshPromise;

  const pendingRefresh = api.post('/auth/refresh').then(() => undefined);
  const wrappedRefresh = pendingRefresh.finally(() => {
    if (refreshPromise === wrappedRefresh) refreshPromise = null;
  });
  refreshPromise = wrappedRefresh;
  return wrappedRefresh;
};

const toAbortReason = (signal: AbortSignal) => (
  signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
);

const waitForRefresh = (signal?: AbortSignal | null) => {
  if (signal?.aborted) return Promise.reject(toAbortReason(signal));
  const pendingRefresh = refreshAccessToken();
  if (!signal) return pendingRefresh;

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(toAbortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pendingRefresh.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

export const authenticatedFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const retryInput = typeof Request !== 'undefined' && input instanceof Request
    ? input.clone()
    : input;
  const response = await fetch(input, init);
  if (response.status !== 401 || isAuthBootstrapRequest(input)) return response;

  const signal = init?.signal
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
  await waitForRefresh(signal);
  return fetch(retryInput, init);
};

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as RetryableAxiosRequestConfig | undefined;

    if (
      !originalRequest
      || isAuthBootstrapRequest(originalRequest.url || '')
      || error.response?.status !== 401
      || originalRequest._retry
    ) {
      return Promise.reject(error);
    }

    originalRequest._retry = true;
    await waitForRefresh(originalRequest.signal as AbortSignal | undefined);
    return api(originalRequest);
  },
);

export default api;

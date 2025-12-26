import axios, { type AxiosError } from 'axios';

const api = axios.create({
  baseURL: '/api', // Vite proxy will handle this
  withCredentials: true, // Important for Cookies
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 60000, // 60s timeout
});

// Flag to track if token refresh is in progress
let isRefreshing = false;

interface FailedRequest {
  resolve: (value: boolean | PromiseLike<boolean>) => void;
  reject: (reason?: unknown) => void;
}

// Queue to hold requests that are waiting for the token refresh
let failedQueue: FailedRequest[] = [];

const processQueue = (error: unknown, tokenRefreshed: boolean = false) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(tokenRefreshed);
    }
  });

  failedQueue = [];
};

// Response interceptor for auto-refresh
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config;

    if (!originalRequest) {
      return Promise.reject(error);
    }

    // Prevent infinite loops: if the error comes from the refresh endpoint itself, reject immediately
    if (originalRequest.url?.includes('/auth/refresh')) {
      return Promise.reject(error);
    }

    // Check if error is 401 and we haven't retried yet
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (error.response?.status === 401 && !(originalRequest as any)._retry) {
      if (isRefreshing) {
        // If refreshing is already in progress, add this request to queue
        return new Promise<boolean>(function (resolve, reject) {
          failedQueue.push({ resolve, reject });
        }).then(() => {
          return api(originalRequest);
        }).catch(err => {
          return Promise.reject(err);
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (originalRequest as any)._retry = true;
      isRefreshing = true;

      try {
        // Attempt to refresh token
        await api.post('/auth/refresh');

        // If successful, process queue and retry original request
        processQueue(null, true);
        return api(originalRequest);
      } catch (refreshError) {
        // If refresh fails, reject all queued requests
        processQueue(refreshError, false);
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;

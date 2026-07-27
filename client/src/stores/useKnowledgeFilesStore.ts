import { create } from 'zustand';
import api from '../lib/api';
import { toSafeError } from '../lib/safeError';
import { createCompletionPoller, isRequestAbortError } from './requestGeneration';

export interface KnowledgeFile {
  id: string;
  filename: string;
  status: 'uploading' | 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  created_at: string;
  error_message?: string;
  project_space_id?: string | null;
}

interface FetchOptions {
  force?: boolean;
}

interface KnowledgeFilesState {
  files: KnowledgeFile[];
  loading: boolean;
  loaded: boolean;
  projectSpaceId: string | null;
  lastFetchedAt: number;
  fetchFiles: (projectSpaceId: string | null, options?: FetchOptions) => Promise<void>;
  refreshFiles: (projectSpaceId: string | null) => Promise<void>;
  startPolling: (projectSpaceId: string | null) => void;
  stopPolling: (projectSpaceId: string | null) => void;
  cancelFetch: (projectSpaceId: string | null) => void;
  removeFile: (id: string) => void;
  upsertFile: (file: KnowledgeFile) => void;
  reset: () => void;
}

interface ActiveRequest {
  scope: string;
  controller: AbortController;
  promise: Promise<void>;
}

const FRESHNESS_WINDOW_MS = 2_000;
const POLL_INTERVAL_MS = 3_000;
const DEFAULT_SCOPE = '__default-project-space__';

const toScope = (projectSpaceId: string | null) => projectSpaceId || DEFAULT_SCOPE;
const hasActiveFiles = (files: KnowledgeFile[]) => files.some(
  (file) => file.status === 'uploading'
    || file.status === 'pending'
    || file.status === 'processing',
);

let activeRequest: ActiveRequest | null = null;
let pollingProjectSpaceId: string | null | undefined;

const poller = createCompletionPoller(async () => {
  if (pollingProjectSpaceId === undefined) return;
  await useKnowledgeFilesStore.getState().fetchFiles(pollingProjectSpaceId);
}, POLL_INTERVAL_MS);

const initialState = {
  files: [] as KnowledgeFile[],
  loading: false,
  loaded: false,
  projectSpaceId: null,
  lastFetchedAt: 0,
};

export const useKnowledgeFilesStore = create<KnowledgeFilesState>((set, get) => ({
  ...initialState,

  fetchFiles: (projectSpaceId, options = {}) => {
    const scope = toScope(projectSpaceId);
    const state = get();
    const isCurrentScope = state.loaded && state.projectSpaceId === projectSpaceId;
    const isFresh = isCurrentScope
      && Date.now() - state.lastFetchedAt < FRESHNESS_WINDOW_MS;

    if (!options.force && isFresh) return Promise.resolve();
    if (!options.force && activeRequest?.scope === scope) return activeRequest.promise;

    activeRequest?.controller.abort();
    const controller = new AbortController();
    if (state.projectSpaceId !== projectSpaceId) {
      set({
        files: [],
        loaded: false,
        projectSpaceId,
        lastFetchedAt: 0,
      });
    }
    set({ loading: true });

    const promise = (async () => {
      try {
        const response = await api.get<KnowledgeFile[]>('/upload/files', {
          params: { projectSpaceId: projectSpaceId || undefined },
          signal: controller.signal,
        });
        if (activeRequest?.controller !== controller || controller.signal.aborted) return;

        const files = response.data;
        set({
          files,
          loading: false,
          loaded: true,
          projectSpaceId,
          lastFetchedAt: Date.now(),
        });

        if (pollingProjectSpaceId === projectSpaceId) {
          if (hasActiveFiles(files)) poller.start();
          else poller.stop();
        }
      } catch (error) {
        if (activeRequest?.controller === controller && !isRequestAbortError(error)) {
          set({ loading: false });
          console.error('Failed to fetch knowledge files:', toSafeError(error));
        }
      } finally {
        if (activeRequest?.controller === controller) activeRequest = null;
      }
    })();

    activeRequest = { scope, controller, promise };
    return promise;
  },

  refreshFiles: (projectSpaceId) => get().fetchFiles(projectSpaceId, { force: true }),

  startPolling: (projectSpaceId) => {
    pollingProjectSpaceId = projectSpaceId;
    const state = get();
    const isFresh = state.loaded
      && state.projectSpaceId === projectSpaceId
      && Date.now() - state.lastFetchedAt < FRESHNESS_WINDOW_MS;
    if (isFresh) {
      if (hasActiveFiles(state.files)) poller.start();
      else poller.stop();
      return;
    }
    poller.startNow();
  },

  stopPolling: (projectSpaceId) => {
    if (pollingProjectSpaceId !== projectSpaceId) return;
    pollingProjectSpaceId = undefined;
    poller.stop();
  },

  cancelFetch: (projectSpaceId) => {
    if (activeRequest?.scope !== toScope(projectSpaceId)) return;
    activeRequest.controller.abort();
    activeRequest = null;
    set({ loading: false });
  },

  removeFile: (id) => set((state) => ({
    files: state.files.filter((file) => file.id !== id),
  })),

  upsertFile: (file) => set((state) => {
    const exists = state.files.some((current) => current.id === file.id);
    return {
      files: exists
        ? state.files.map((current) => current.id === file.id ? file : current)
        : [file, ...state.files],
    };
  }),

  reset: () => {
    activeRequest?.controller.abort();
    activeRequest = null;
    pollingProjectSpaceId = undefined;
    poller.stop();
    set(initialState);
  },
}));

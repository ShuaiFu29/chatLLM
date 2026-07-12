import { create } from 'zustand';
import api from '../lib/api';
import { toSafeError } from '../lib/safeError';
import { isRequestAbortError, RequestGenerationGuard } from './requestGeneration';

export interface ProjectSpace {
  id: string;
  user_id: string;
  name: string;
  description: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

interface ProjectSpaceState {
  projectSpaces: ProjectSpace[];
  currentProjectSpaceId: string | null;
  loadingProjectSpaces: boolean;
  fetchProjectSpaces: () => Promise<void>;
  createProjectSpace: (name: string) => Promise<string>;
  renameProjectSpace: (id: string, name: string) => Promise<void>;
  deleteProjectSpace: (id: string) => Promise<void>;
  selectProjectSpace: (id: string) => void;
}

const STORAGE_KEY = 'chatllm.currentProjectSpaceId';
const projectSpaceRequestGuard = new RequestGenerationGuard();

export const useProjectSpaceStore = create<ProjectSpaceState>((set, get) => ({
  projectSpaces: [],
  currentProjectSpaceId: localStorage.getItem(STORAGE_KEY),
  loadingProjectSpaces: false,

  fetchProjectSpaces: async () => {
    const ticket = projectSpaceRequestGuard.begin('list');
    set({ loadingProjectSpaces: true });
    try {
      const res = await api.get<ProjectSpace[]>('/project-spaces', {
        signal: ticket.controller.signal,
      });
      if (!projectSpaceRequestGuard.isCurrent(ticket)) return;
      const spaces = res.data;
      const currentId = get().currentProjectSpaceId;
      const hasCurrent = currentId && spaces.some((space) => space.id === currentId);
      const nextCurrentId = hasCurrent ? currentId : spaces[0]?.id || null;

      if (nextCurrentId) {
        localStorage.setItem(STORAGE_KEY, nextCurrentId);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }

      set({ projectSpaces: spaces, currentProjectSpaceId: nextCurrentId });
    } catch (err) {
      if (projectSpaceRequestGuard.isCurrent(ticket) && !isRequestAbortError(err)) {
        console.error('Failed to fetch project spaces:', toSafeError(err));
      }
    } finally {
      if (projectSpaceRequestGuard.finish(ticket)) set({ loadingProjectSpaces: false });
    }
  },

  createProjectSpace: async (name: string) => {
    const res = await api.post<ProjectSpace>('/project-spaces', { name });
    const space = res.data;
    projectSpaceRequestGuard.abort('list');
    set((state) => ({
      projectSpaces: [space, ...state.projectSpaces],
      currentProjectSpaceId: space.id,
      loadingProjectSpaces: false,
    }));
    localStorage.setItem(STORAGE_KEY, space.id);
    return space.id;
  },

  renameProjectSpace: async (id: string, name: string) => {
    projectSpaceRequestGuard.abort('list');
    const ticket = projectSpaceRequestGuard.begin(`rename:${id}`);
    set((state) => ({
      projectSpaces: state.projectSpaces.map((space) =>
        space.id === id ? { ...space, name } : space
      ),
      loadingProjectSpaces: false,
    }));

    try {
      const res = await api.patch<ProjectSpace>(`/project-spaces/${id}`, { name }, {
        signal: ticket.controller.signal,
      });
      if (!projectSpaceRequestGuard.isCurrent(ticket)) return;
      const updatedSpace = res.data;
      projectSpaceRequestGuard.abort('list');
      set((state) => ({
        projectSpaces: state.projectSpaces.map((space) =>
          space.id === id ? updatedSpace : space
        ),
        loadingProjectSpaces: false,
      }));
    } catch (err) {
      if (!projectSpaceRequestGuard.isCurrent(ticket) || isRequestAbortError(err)) return;
      await get().fetchProjectSpaces();
      console.error('Failed to rename project space:', toSafeError(err));
      throw err;
    } finally {
      projectSpaceRequestGuard.finish(ticket);
    }
  },

  deleteProjectSpace: async (id: string) => {
    const previousSpaces = get().projectSpaces;
    const previousCurrentId = get().currentProjectSpaceId;
    const remainingSpaces = previousSpaces.filter((space) => space.id !== id);
    const nextCurrentId = previousCurrentId === id
      ? remainingSpaces[0]?.id || null
      : previousCurrentId;

    projectSpaceRequestGuard.abort('list');
    const ticket = projectSpaceRequestGuard.begin(`delete:${id}`);
    set({
      projectSpaces: remainingSpaces,
      currentProjectSpaceId: nextCurrentId,
      loadingProjectSpaces: false,
    });

    if (nextCurrentId) {
      localStorage.setItem(STORAGE_KEY, nextCurrentId);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }

    try {
      await api.delete(`/project-spaces/${id}`, { signal: ticket.controller.signal });
      if (!projectSpaceRequestGuard.isCurrent(ticket)) return;
      projectSpaceRequestGuard.abort('list');
      set((state) => {
        const projectSpaces = state.projectSpaces.filter((space) => space.id !== id);
        const currentProjectSpaceId = state.currentProjectSpaceId === id
          ? projectSpaces[0]?.id || null
          : state.currentProjectSpaceId;
        return { projectSpaces, currentProjectSpaceId, loadingProjectSpaces: false };
      });
      const currentProjectSpaceId = get().currentProjectSpaceId;
      if (currentProjectSpaceId) {
        localStorage.setItem(STORAGE_KEY, currentProjectSpaceId);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (err) {
      if (!projectSpaceRequestGuard.isCurrent(ticket) || isRequestAbortError(err)) return;
      await get().fetchProjectSpaces();
      console.error('Failed to delete project space:', toSafeError(err));
      throw err;
    } finally {
      projectSpaceRequestGuard.finish(ticket);
    }
  },

  selectProjectSpace: (id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    set({ currentProjectSpaceId: id });
  },
}));

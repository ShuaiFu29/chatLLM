import { create } from 'zustand';
import api from '../lib/api';

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

export const useProjectSpaceStore = create<ProjectSpaceState>((set, get) => ({
  projectSpaces: [],
  currentProjectSpaceId: localStorage.getItem(STORAGE_KEY),
  loadingProjectSpaces: false,

  fetchProjectSpaces: async () => {
    set({ loadingProjectSpaces: true });
    try {
      const res = await api.get<ProjectSpace[]>('/project-spaces');
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
      console.error('Failed to fetch project spaces:', err);
    } finally {
      set({ loadingProjectSpaces: false });
    }
  },

  createProjectSpace: async (name: string) => {
    const res = await api.post<ProjectSpace>('/project-spaces', { name });
    const space = res.data;
    set((state) => ({
      projectSpaces: [space, ...state.projectSpaces],
      currentProjectSpaceId: space.id,
    }));
    localStorage.setItem(STORAGE_KEY, space.id);
    return space.id;
  },

  renameProjectSpace: async (id: string, name: string) => {
    const previousSpaces = get().projectSpaces;
    set((state) => ({
      projectSpaces: state.projectSpaces.map((space) =>
        space.id === id ? { ...space, name } : space
      ),
    }));

    try {
      const res = await api.patch<ProjectSpace>(`/project-spaces/${id}`, { name });
      const updatedSpace = res.data;
      set((state) => ({
        projectSpaces: state.projectSpaces.map((space) =>
          space.id === id ? updatedSpace : space
        ),
      }));
    } catch (err) {
      set({ projectSpaces: previousSpaces });
      console.error('Failed to rename project space:', err);
      throw err;
    }
  },

  deleteProjectSpace: async (id: string) => {
    const previousSpaces = get().projectSpaces;
    const previousCurrentId = get().currentProjectSpaceId;
    const remainingSpaces = previousSpaces.filter((space) => space.id !== id);
    const nextCurrentId = previousCurrentId === id
      ? remainingSpaces[0]?.id || null
      : previousCurrentId;

    set({
      projectSpaces: remainingSpaces,
      currentProjectSpaceId: nextCurrentId,
    });

    if (nextCurrentId) {
      localStorage.setItem(STORAGE_KEY, nextCurrentId);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }

    try {
      await api.delete(`/project-spaces/${id}`);
    } catch (err) {
      set({
        projectSpaces: previousSpaces,
        currentProjectSpaceId: previousCurrentId,
      });
      if (previousCurrentId) {
        localStorage.setItem(STORAGE_KEY, previousCurrentId);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
      console.error('Failed to delete project space:', err);
      throw err;
    }
  },

  selectProjectSpace: (id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    set({ currentProjectSpaceId: id });
  },
}));

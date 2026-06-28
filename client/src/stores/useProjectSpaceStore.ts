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

  selectProjectSpace: (id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    set({ currentProjectSpaceId: id });
  },
}));

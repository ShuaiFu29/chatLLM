import { create } from 'zustand';
import api from '../lib/api';
import { toSafeError } from '../lib/safeError';
import type { Message } from './useChatStore';
import { isRequestAbortError, RequestGenerationGuard } from './requestGeneration';

export interface SearchResult extends Message {
  conversation_id: string;
  conversations: {
    id: string;
    title: string;
    user_id: string;
    project_space_id?: string | null;
    is_favorite?: boolean;
    tags?: string[];
    archived_at?: string | null;
  };
}

export interface SearchFilters {
  projectSpaceId: string;
  hasSources: boolean;
  model: string;
  favoriteOnly: boolean;
  tag: string;
  includeArchived: boolean;
}

interface SearchState {
  isOpen: boolean;
  query: string;
  results: SearchResult[];
  isLoading: boolean;
  filters: SearchFilters;

  setIsOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  setFilters: (filters: Partial<SearchFilters>) => void;
  searchMessages: (query: string) => Promise<void>;
  clearResults: () => void;
}

const defaultFilters: SearchFilters = {
  projectSpaceId: '',
  hasSources: false,
  model: '',
  favoriteOnly: false,
  tag: '',
  includeArchived: false,
};

const searchRequestGuard = new RequestGenerationGuard();

export const useSearchStore = create<SearchState>((set, get) => ({
  isOpen: false,
  query: '',
  results: [],
  isLoading: false,
  filters: defaultFilters,

  setIsOpen: (open) => set({ isOpen: open }),

  setQuery: (query) => {
    searchRequestGuard.abort('search');
    set({ query, isLoading: false });
  },

  setFilters: (filters) => {
    searchRequestGuard.abort('search');
    set((state) => ({
      filters: { ...state.filters, ...filters },
      isLoading: false,
    }));
  },

  searchMessages: async (query: string) => {
    if (!query.trim()) {
      searchRequestGuard.abort('search');
      set({ results: [], isLoading: false });
      return;
    }

    const ticket = searchRequestGuard.begin('search');
    set({ isLoading: true });
    try {
      const filters = get().filters;
      const res = await api.get('/search', {
        params: {
          q: query,
          projectSpaceId: filters.projectSpaceId || undefined,
          hasSources: filters.hasSources || undefined,
          model: filters.model || undefined,
          favoriteOnly: filters.favoriteOnly || undefined,
          tag: filters.tag || undefined,
          includeArchived: filters.includeArchived || undefined,
        },
        signal: ticket.controller.signal,
      });
      if (searchRequestGuard.isCurrent(ticket)) set({ results: res.data });
    } catch (err) {
      if (searchRequestGuard.isCurrent(ticket) && !isRequestAbortError(err)) {
        console.error('Search failed:', toSafeError(err));
        set({ results: [] });
      }
    } finally {
      if (searchRequestGuard.finish(ticket)) set({ isLoading: false });
    }
  },

  clearResults: () => {
    searchRequestGuard.abort('search');
    set({ results: [], query: '', isLoading: false });
  }
}));

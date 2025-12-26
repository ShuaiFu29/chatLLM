import { create } from 'zustand';
import api from '../lib/api';
import type { Message } from './useChatStore';

interface SearchResult extends Message {
  conversation_id: string;
  conversations: {
    id: string;
    title: string;
    user_id: string;
  };
}

interface SearchState {
  isOpen: boolean;
  query: string;
  results: SearchResult[];
  isLoading: boolean;

  setIsOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  searchMessages: (query: string) => Promise<void>;
  clearResults: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  isOpen: false,
  query: '',
  results: [],
  isLoading: false,

  setIsOpen: (open) => set({ isOpen: open }),

  setQuery: (query) => set({ query }),

  searchMessages: async (query: string) => {
    if (!query.trim()) {
      set({ results: [], isLoading: false });
      return;
    }

    set({ isLoading: true });
    try {
      // Encode the query parameter properly to handle special characters
      // Note: axios params option automatically encodes, but let's be explicit if needed
      // Actually axios handles it. The issue might be the 404 from before.
      // But looking at the console logs, it seems it was 404ing on /api/chat/search?q=...

      const res = await api.get('/search', { params: { q: query } });
      console.log('[Frontend] Search response:', res.data); // Log the response
      set({ results: res.data });
    } catch (err) {
      console.error('Search failed:', err);
      set({ results: [] });
    } finally {
      set({ isLoading: false });
    }
  },

  clearResults: () => set({ results: [], query: '' })
}));
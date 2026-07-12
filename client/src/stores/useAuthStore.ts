import { create } from 'zustand';
import api from '../lib/api';
import { toSafeError } from '../lib/safeError';

interface UserSettings {
  temperature?: number;
  model?: string;
  system_prompt?: string;
}

export interface User {
  id: string;
  username: string; // Changed from login to match server
  avatar_url: string;
  display_name?: string; // Changed from name to match server
  settings?: UserSettings;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  checkAuth: (force?: boolean) => Promise<void>;
  login: () => void;
  logout: () => Promise<void>;
  updateProfile: (data: Partial<User>) => Promise<void>;
  deleteAccount: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,

  checkAuth: async (force = false) => {
    // Check if user has logged in before to avoid unnecessary 401s on initial load
    const hasLoggedIn = localStorage.getItem('has_logged_in');

    if (!force && !hasLoggedIn) {
      set({ user: null, loading: false });
      return;
    }

    try {
      // api instance handles interceptors for 401->refresh
      const res = await api.get('/auth/me');
      set({ user: res.data.user });
      localStorage.setItem('has_logged_in', 'true');
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;

      if (status === 401) {
        set({ user: null });
        localStorage.removeItem('has_logged_in');
      } else {
        set({ user: null });
      }
    } finally {
      set({ loading: false });
    }
  },

  login: () => {
    // Use relative path to leverage Vite proxy
    window.location.href = '/api/auth/github/login';
  },

  logout: async () => {
    try {
      await api.post('/auth/logout');
    } catch (err) {
      console.warn('Logout request failed; clearing local session anyway.', toSafeError(err));
    } finally {
      set({ user: null });
      localStorage.removeItem('has_logged_in');
    }
  },

  updateProfile: async (data: Partial<User>) => {
    const res = await api.put('/auth/me', data);
    set({ user: res.data.user });
  },

  deleteAccount: async () => {
    await api.delete('/auth/me');
    set({ user: null });
    localStorage.removeItem('has_logged_in');
    window.location.href = '/login';
  }
}));

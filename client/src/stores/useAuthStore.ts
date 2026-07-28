import { create } from 'zustand';
import api from '../lib/api';
import { authSessionHintStorage } from '../lib/localStorage';
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

interface PasswordLoginInput {
  email: string;
  password: string;
  rememberMe: boolean;
}

interface RegisterInput extends PasswordLoginInput {
  displayName: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  checkAuth: (force?: boolean) => Promise<void>;
  loginWithPassword: (input: PasswordLoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  loginWithGithub: (rememberMe: boolean) => void;
  logout: () => Promise<void>;
  updateProfile: (data: Partial<User>) => Promise<void>;
  deleteAccount: () => Promise<void>;
}

let authStateRevision = 0;
let authCheckPromise: Promise<void> | null = null;

const advanceAuthStateRevision = () => {
  authStateRevision += 1;
  return authStateRevision;
};

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,

  checkAuth: (force = false) => {
    if (authCheckPromise) return authCheckPromise;

    // Check if user has logged in before to avoid unnecessary 401s on initial load
    const hasLoggedIn = authSessionHintStorage.read();

    if (!force && hasLoggedIn === false) {
      set({ user: null, loading: false });
      return Promise.resolve();
    }

    const requestRevision = authStateRevision;
    set({ loading: true });
    const pendingCheck = (async () => {
      try {
        // api instance handles interceptors for 401->refresh
        const res = await api.get<{ user: User }>('/auth/me');
        if (requestRevision !== authStateRevision) return;
        set({ user: res.data.user });
        authSessionHintStorage.write(true);
      } catch (err: unknown) {
        if (requestRevision !== authStateRevision) return;
        const { status } = toSafeError(err);

        set({ user: null });
        if (status === 401) authSessionHintStorage.write(false);
      } finally {
        if (requestRevision === authStateRevision) set({ loading: false });
        authCheckPromise = null;
      }
    })();
    authCheckPromise = pendingCheck;
    return pendingCheck;
  },

  loginWithPassword: async (input) => {
    const operationRevision = advanceAuthStateRevision();
    set({ loading: false });
    const res = await api.post<{ user: User }>('/auth/login', input);
    if (operationRevision !== authStateRevision) return;
    set({ user: res.data.user, loading: false });
    authSessionHintStorage.write(true);
  },

  register: async (input) => {
    const operationRevision = advanceAuthStateRevision();
    set({ loading: false });
    const res = await api.post<{ user: User }>('/auth/register', input);
    if (operationRevision !== authStateRevision) return;
    set({ user: res.data.user, loading: false });
    authSessionHintStorage.write(true);
  },

  loginWithGithub: (rememberMe) => {
    const query = new URLSearchParams({ remember: String(rememberMe) });
    window.location.assign(`/api/auth/github/login?${query.toString()}`);
  },

  logout: async () => {
    try {
      await api.post('/auth/logout');
    } catch (err) {
      console.warn('Logout request failed; clearing local session anyway.', toSafeError(err));
    } finally {
      advanceAuthStateRevision();
      set({ user: null, loading: false });
      authSessionHintStorage.write(false);
    }
  },

  updateProfile: async (data: Partial<User>) => {
    const res = await api.put('/auth/me', data);
    advanceAuthStateRevision();
    set({ user: res.data.user, loading: false });
  },

  deleteAccount: async () => {
    await api.delete('/auth/me');
    advanceAuthStateRevision();
    set({ user: null, loading: false });
    authSessionHintStorage.write(false);
    window.location.href = '/login';
  }
}));

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import api from '../lib/api';
import { useAuthStore, type User } from './useAuthStore';

vi.mock('../lib/api', () => ({
  default: {
    delete: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

const user: User = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'ada',
  avatar_url: '',
  display_name: 'Ada',
};

const createMemoryStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn((key: string) => { values.delete(key); }),
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: null, loading: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local authentication actions', () => {
  test('logs in with credentials and stores only the minimal session hint', async () => {
    const { values, storage } = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.mocked(api.post).mockResolvedValue({ data: { user } } as never);
    const input = {
      email: 'ada@example.com',
      password: 'correct horse',
      rememberMe: true,
    };

    await useAuthStore.getState().loginWithPassword(input);

    expect(api.post).toHaveBeenCalledWith('/auth/login', input);
    expect(useAuthStore.getState().user).toEqual(user);
    expect(values.get('chatllm.auth-session-hint:v1')).toBe('{"hasLoggedIn":true}');
    expect(JSON.stringify([...values.entries()])).not.toContain(input.email);
    expect(JSON.stringify([...values.entries()])).not.toContain(input.password);
  });

  test('registers with the display name and remember preference', async () => {
    const { storage } = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.mocked(api.post).mockResolvedValue({ data: { user } } as never);
    const input = {
      displayName: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse',
      rememberMe: false,
    };

    await useAuthStore.getState().register(input);

    expect(api.post).toHaveBeenCalledWith('/auth/register', input);
    expect(useAuthStore.getState().user).toEqual(user);
  });

  test('starts optional GitHub login with the selected remember preference', () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });

    useAuthStore.getState().loginWithGithub(true);

    expect(assign).toHaveBeenCalledWith('/api/auth/github/login?remember=true');
  });
});

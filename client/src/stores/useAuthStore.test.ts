import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import api from '../lib/api';
import { useAuthStore, type User } from './useAuthStore';

vi.mock('../lib/api', () => ({
  authenticatedFetch: vi.fn(),
  default: {
    delete: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

import { useChatStore } from './useChatStore';
import { useKnowledgeFilesStore } from './useKnowledgeFilesStore';
import { useProjectSpaceStore } from './useProjectSpaceStore';
import { useSearchStore } from './useSearchStore';

const user: User = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'ada',
  avatar_url: '',
  display_name: 'Ada',
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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
  useChatStore.getState().reset();
  useKnowledgeFilesStore.getState().reset();
  useProjectSpaceStore.getState().reset();
  useSearchStore.getState().reset();
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

  test('logout clears every user-scoped store before the server request finishes', async () => {
    const response = deferred<void>();
    vi.mocked(api.post).mockReturnValue(response.promise as never);
    useAuthStore.setState({ user, loading: false });
    useChatStore.setState({
      conversations: [{
        id: 'conversation-id',
        title: 'private conversation',
        created_at: '2026-07-28T00:00:00.000Z',
        updated_at: '2026-07-28T00:00:00.000Z',
      }],
    });
    useKnowledgeFilesStore.setState({
      files: [{
        id: 'file-id',
        filename: 'private.pdf',
        status: 'completed',
        progress: 100,
        created_at: '2026-07-28T00:00:00.000Z',
      }],
    });
    useProjectSpaceStore.setState({
      projectSpaces: [{
        id: '22222222-2222-4222-8222-222222222222',
        user_id: user.id,
        name: 'Private workspace',
        description: '',
        is_default: true,
        created_at: '2026-07-28T00:00:00.000Z',
        updated_at: '2026-07-28T00:00:00.000Z',
      }],
      currentProjectSpaceId: '22222222-2222-4222-8222-222222222222',
    });
    useSearchStore.setState({ query: 'private', results: [{ id: 'result-id' } as never] });

    const logout = useAuthStore.getState().logout();

    expect(useAuthStore.getState().user).toBeNull();
    expect(useChatStore.getState().conversations).toEqual([]);
    expect(useKnowledgeFilesStore.getState().files).toEqual([]);
    expect(useProjectSpaceStore.getState().projectSpaces).toEqual([]);
    expect(useProjectSpaceStore.getState().currentProjectSpaceId).toBeNull();
    expect(useSearchStore.getState()).toMatchObject({ query: '', results: [] });

    response.resolve();
    await logout;
  });

  test('deduplicates concurrent authoritative authentication checks', async () => {
    const response = deferred<{ data: { user: User } }>();
    vi.mocked(api.get).mockReturnValue(response.promise as never);

    const firstCheck = useAuthStore.getState().checkAuth(true);
    const secondCheck = useAuthStore.getState().checkAuth(false);

    expect(secondCheck).toBe(firstCheck);
    expect(api.get).toHaveBeenCalledTimes(1);

    response.resolve({ data: { user } });
    await Promise.all([firstCheck, secondCheck]);

    expect(useAuthStore.getState()).toMatchObject({ user, loading: false });
  });

  test('does not let an older authentication check overwrite a later local login', async () => {
    const githubUser = { ...user, id: '22222222-2222-4222-8222-222222222222' };
    const localUser = { ...user, id: '33333333-3333-4333-8333-333333333333' };
    const response = deferred<{ data: { user: User } }>();
    vi.mocked(api.get).mockReturnValue(response.promise as never);
    vi.mocked(api.post).mockResolvedValue({ data: { user: localUser } } as never);

    const authCheck = useAuthStore.getState().checkAuth(true);
    await useAuthStore.getState().loginWithPassword({
      email: 'ada@example.com',
      password: 'correct horse',
      rememberMe: true,
    });
    response.resolve({ data: { user: githubUser } });
    await authCheck;

    expect(useAuthStore.getState()).toMatchObject({ user: localUser, loading: false });
  });

  test('invalidates an older authentication check as soon as local login starts', async () => {
    const githubUser = { ...user, id: '22222222-2222-4222-8222-222222222222' };
    const localUser = { ...user, id: '33333333-3333-4333-8333-333333333333' };
    const authResponse = deferred<{ data: { user: User } }>();
    const loginResponse = deferred<{ data: { user: User } }>();
    vi.mocked(api.get).mockReturnValue(authResponse.promise as never);
    vi.mocked(api.post).mockReturnValue(loginResponse.promise as never);

    const authCheck = useAuthStore.getState().checkAuth(true);
    const login = useAuthStore.getState().loginWithPassword({
      email: 'ada@example.com',
      password: 'correct horse',
      rememberMe: true,
    });
    authResponse.resolve({ data: { user: githubUser } });
    await authCheck;

    expect(useAuthStore.getState()).toMatchObject({ user: null, loading: false });

    loginResponse.resolve({ data: { user: localUser } });
    await login;
    expect(useAuthStore.getState()).toMatchObject({ user: localUser, loading: false });
  });

  test('does not let a stale 401 clear a newer login session hint', async () => {
    const { values, storage } = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    const response = deferred<{ data: { user: User } }>();
    vi.mocked(api.get).mockReturnValue(response.promise as never);
    vi.mocked(api.post).mockResolvedValue({ data: { user } } as never);

    const authCheck = useAuthStore.getState().checkAuth(true);
    await useAuthStore.getState().loginWithPassword({
      email: 'ada@example.com',
      password: 'correct horse',
      rememberMe: false,
    });
    response.reject({ response: { status: 401 } });
    await authCheck;

    expect(values.get('chatllm.auth-session-hint:v1')).toBe('{"hasLoggedIn":true}');
    expect(useAuthStore.getState()).toMatchObject({ user, loading: false });
  });
});

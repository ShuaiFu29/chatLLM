import { afterEach, expect, test, vi } from 'vitest';
import {
  authSessionHintStorage,
  currentProjectSpaceStorage,
  safeLocalStorage,
} from './localStorage';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

test('safe local storage degrades without throwing when browser storage is unavailable', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => { throw new Error('storage denied'); },
    setItem: () => { throw new Error('storage denied'); },
    removeItem: () => { throw new Error('storage denied'); },
  });

  expect(safeLocalStorage.getItem('key')).toBeNull();
  expect(safeLocalStorage.setItem('key', 'value')).toBe(false);
  expect(safeLocalStorage.removeItem('key')).toBe(false);
  expect(authSessionHintStorage.read()).toBeNull();
  expect(currentProjectSpaceStorage.read()).toBeNull();
});

test('auth session hint migrates its legacy scalar into a minimal versioned record', () => {
  const { values, storage } = createMemoryStorage();
  values.set('has_logged_in', 'true');
  vi.stubGlobal('localStorage', storage);

  expect(authSessionHintStorage.read()).toBe(true);
  expect(values.get('chatllm.auth-session-hint:v1')).toBe('{"hasLoggedIn":true}');
  expect(values.has('has_logged_in')).toBe(false);

  authSessionHintStorage.write(false);
  expect(values.has('chatllm.auth-session-hint:v1')).toBe(false);
});

test('project-space selection migrates valid ids and removes corrupted values', () => {
  const { values, storage } = createMemoryStorage();
  const projectSpaceId = '77777777-7777-4777-8777-777777777777';
  values.set('chatllm.currentProjectSpaceId', projectSpaceId);
  vi.stubGlobal('localStorage', storage);

  expect(currentProjectSpaceStorage.read()).toBe(projectSpaceId);
  expect(values.get('chatllm.current-project-space:v1')).toBe(
    JSON.stringify({ id: projectSpaceId }),
  );
  expect(values.has('chatllm.currentProjectSpaceId')).toBe(false);

  values.set('chatllm.current-project-space:v1', '{broken-json');
  expect(currentProjectSpaceStorage.read()).toBeNull();
  expect(values.has('chatllm.current-project-space:v1')).toBe(false);
});

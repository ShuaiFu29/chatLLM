const AUTH_SESSION_HINT_KEY = 'chatllm.auth-session-hint:v1';
const CURRENT_PROJECT_SPACE_KEY = 'chatllm.current-project-space:v1';

const LEGACY_AUTH_SESSION_HINT_KEY = 'has_logged_in';
const LEGACY_CURRENT_PROJECT_SPACE_KEY = 'chatllm.currentProjectSpaceId';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const readStorageItem = (key: string) => {
  try {
    const storage = getStorage();
    if (!storage) return { available: false, value: null };
    return { available: true, value: storage.getItem(key) };
  } catch {
    return { available: false, value: null };
  }
};

export const safeLocalStorage = {
  getItem(key: string) {
    return readStorageItem(key).value;
  },

  setItem(key: string, value: string) {
    try {
      getStorage()?.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },

  removeItem(key: string) {
    try {
      getStorage()?.removeItem(key);
      return true;
    } catch {
      return false;
    }
  },
};

const parseStoredObject = (value: string | null): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

export const authSessionHintStorage = {
  read() {
    const currentResult = readStorageItem(AUTH_SESSION_HINT_KEY);
    if (!currentResult.available) return null;
    const currentValue = currentResult.value;
    const current = parseStoredObject(currentValue);
    if (current?.hasLoggedIn === true) return true;

    const legacyResult = readStorageItem(LEGACY_AUTH_SESSION_HINT_KEY);
    if (!legacyResult.available) return null;
    const legacyValue = legacyResult.value;
    if (legacyValue !== 'true') {
      if (currentValue !== null) safeLocalStorage.removeItem(AUTH_SESSION_HINT_KEY);
      if (legacyValue !== null) safeLocalStorage.removeItem(LEGACY_AUTH_SESSION_HINT_KEY);
      return false;
    }

    safeLocalStorage.setItem(AUTH_SESSION_HINT_KEY, JSON.stringify({ hasLoggedIn: true }));
    safeLocalStorage.removeItem(LEGACY_AUTH_SESSION_HINT_KEY);
    return true;
  },

  write(hasLoggedIn: boolean) {
    safeLocalStorage.removeItem(LEGACY_AUTH_SESSION_HINT_KEY);
    if (hasLoggedIn) {
      safeLocalStorage.setItem(AUTH_SESSION_HINT_KEY, JSON.stringify({ hasLoggedIn: true }));
    } else {
      safeLocalStorage.removeItem(AUTH_SESSION_HINT_KEY);
    }
  },
};

const parseProjectSpaceId = (value: unknown) => (
  typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
);

export const currentProjectSpaceStorage = {
  read() {
    const currentValue = safeLocalStorage.getItem(CURRENT_PROJECT_SPACE_KEY);
    const current = parseStoredObject(currentValue);
    const currentId = parseProjectSpaceId(current?.id);
    if (currentId) return currentId;

    const legacyValue = safeLocalStorage.getItem(LEGACY_CURRENT_PROJECT_SPACE_KEY);
    const legacyId = parseProjectSpaceId(legacyValue);
    if (!legacyId) {
      if (currentValue !== null) safeLocalStorage.removeItem(CURRENT_PROJECT_SPACE_KEY);
      if (legacyValue !== null) safeLocalStorage.removeItem(LEGACY_CURRENT_PROJECT_SPACE_KEY);
      return null;
    }

    safeLocalStorage.setItem(CURRENT_PROJECT_SPACE_KEY, JSON.stringify({ id: legacyId }));
    safeLocalStorage.removeItem(LEGACY_CURRENT_PROJECT_SPACE_KEY);
    return legacyId;
  },

  write(id: string | null) {
    safeLocalStorage.removeItem(LEGACY_CURRENT_PROJECT_SPACE_KEY);
    const validId = parseProjectSpaceId(id);
    if (validId) {
      safeLocalStorage.setItem(CURRENT_PROJECT_SPACE_KEY, JSON.stringify({ id: validId }));
    } else {
      safeLocalStorage.removeItem(CURRENT_PROJECT_SPACE_KEY);
    }
  },
};

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { serverEnv } from './env';
import { validateAgentToolSecrets } from './agentToolSecretKeys';

const LEGACY_VERSION = 'v1';
const VERSION = 'v2';
const ALGORITHM = 'aes-256-gcm';
const LEGACY_AAD = Buffer.from('chatllm-agent-tool-secrets', 'utf8');
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface AgentToolSecretContext {
  userId: string;
  toolId: string;
  secretVersion: number;
}

export interface AgentToolSecretKeyring {
  activeKeyId?: string;
  keys: Readonly<Record<string, string>>;
}

export interface AgentToolSecretEnvelopeMetadata {
  envelopeVersion: 1 | 2;
  keyId: string | null;
}

export class AgentToolEncryptionUnavailableError extends Error {
  constructor() {
    super('Agent tool credential encryption is not configured');
    this.name = 'AgentToolEncryptionUnavailableError';
  }
}

const encryptionKey = (keyHex?: string) => {
  if (!keyHex || !/^[a-fA-F0-9]{64}$/.test(keyHex)) {
    throw new AgentToolEncryptionUnavailableError();
  }
  return Buffer.from(keyHex, 'hex');
};

const configuredKeyring = (): AgentToolSecretKeyring => {
  const keys = { ...serverEnv.AGENT_TOOL_ENCRYPTION_KEYS };
  let activeKeyId = serverEnv.AGENT_TOOL_ENCRYPTION_ACTIVE_KEY_ID;
  if (serverEnv.AGENT_TOOL_ENCRYPTION_KEY) {
    if (Object.keys(keys).length === 0) {
      const compatibilityKeyId = activeKeyId || 'default';
      keys[compatibilityKeyId] = serverEnv.AGENT_TOOL_ENCRYPTION_KEY;
      activeKeyId ||= compatibilityKeyId;
    } else if (!Object.values(keys).includes(serverEnv.AGENT_TOOL_ENCRYPTION_KEY)) {
      let legacyKeyId = 'legacy';
      let suffix = 1;
      while (keys[legacyKeyId]) {
        suffix += 1;
        legacyKeyId = `legacy_${suffix}`;
      }
      // v1 envelopes have no key ID. Retaining the former single key as a
      // decrypt-only candidate is what makes the first keyring rollout safe.
      keys[legacyKeyId] = serverEnv.AGENT_TOOL_ENCRYPTION_KEY;
    }
  }
  return { activeKeyId, keys };
};

export const getActiveAgentToolSecretKeyId = () => (
  configuredKeyring().activeKeyId || null
);

export const agentToolSecretEncryptionConfigured = () => {
  const keyring = configuredKeyring();
  return Boolean(keyring.activeKeyId && keyring.keys[keyring.activeKeyId]);
};

const normalizeKeyring = (
  value?: string | AgentToolSecretKeyring,
): AgentToolSecretKeyring => {
  if (typeof value === 'string') {
    return { activeKeyId: 'explicit', keys: { explicit: value } };
  }
  return value || configuredKeyring();
};

const aadFor = (context: AgentToolSecretContext) => {
  if (
    !context.userId
    || !context.toolId
    || !Number.isSafeInteger(context.secretVersion)
    || context.secretVersion < 1
  ) {
    throw new Error('Invalid Agent tool Secret encryption context');
  }
  return Buffer.from(JSON.stringify({
    format_version: 2,
    purpose: 'chatllm-agent-tool-secrets',
    user_id: context.userId,
    tool_id: context.toolId,
    secret_version: context.secretVersion,
  }), 'utf8');
};

const parsePlaintext = (plaintext: string) => {
  const parsed = JSON.parse(plaintext) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Agent tool secret payload');
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== 'string') throw new Error('Invalid Agent tool secret value');
  }
  const secrets = parsed as Record<string, string>;
  validateAgentToolSecrets(secrets);
  return secrets;
};

const decryptWithKey = (input: {
  ivValue: string;
  tagValue: string;
  encryptedValue: string;
  keyHex: string;
  aad: Buffer;
}) => {
  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(input.keyHex),
    Buffer.from(input.ivValue, 'base64url'),
  );
  decipher.setAAD(input.aad);
  decipher.setAuthTag(Buffer.from(input.tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(input.encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
};

export const encryptAgentToolSecrets = (
  secrets: Record<string, string>,
  contextOrLegacyKey?: AgentToolSecretContext | string,
  keyringValue?: string | AgentToolSecretKeyring,
) => {
  validateAgentToolSecrets(secrets);
  const iv = randomBytes(12);
  // A context-free call is retained only to read/write pre-R4 fixtures and
  // existing deployments during migration. All management API writes provide a
  // row context and therefore produce the bound v2 envelope below.
  if (typeof contextOrLegacyKey === 'string' || contextOrLegacyKey === undefined) {
    const legacyKey = typeof contextOrLegacyKey === 'string'
      ? contextOrLegacyKey
      : serverEnv.AGENT_TOOL_ENCRYPTION_KEY;
    const cipher = createCipheriv(ALGORITHM, encryptionKey(legacyKey), iv);
    cipher.setAAD(LEGACY_AAD);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(secrets), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      LEGACY_VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  const keyring = normalizeKeyring(keyringValue);
  const keyId = keyring.activeKeyId;
  if (!keyId || !KEY_ID.test(keyId)) throw new AgentToolEncryptionUnavailableError();
  const cipher = createCipheriv(ALGORITHM, encryptionKey(keyring.keys[keyId]), iv);
  cipher.setAAD(aadFor(contextOrLegacyKey));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(secrets), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    keyId,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
};

export const decryptAgentToolSecrets = (
  payload: string,
  contextOrLegacyKey?: AgentToolSecretContext | string,
  keyringValue?: string | AgentToolSecretKeyring,
) => {
  const parts = payload.split('.');
  if (parts[0] === VERSION) {
    const [version, keyId, ivValue, tagValue, encryptedValue, extra] = parts;
    if (
      version !== VERSION
      || !keyId
      || !KEY_ID.test(keyId)
      || !ivValue
      || !tagValue
      || !encryptedValue
      || extra
      || !contextOrLegacyKey
      || typeof contextOrLegacyKey === 'string'
    ) {
      throw new Error('Unsupported encrypted Agent tool secret payload');
    }
    const keyring = normalizeKeyring(keyringValue);
    const keyHex = keyring.keys[keyId];
    if (!keyHex) {
      throw new AgentToolEncryptionUnavailableError();
    }
    return parsePlaintext(decryptWithKey({
      ivValue,
      tagValue,
      encryptedValue,
      keyHex,
      aad: aadFor(contextOrLegacyKey),
    }));
  }

  const [version, ivValue, tagValue, encryptedValue, extra] = parts;
  if (
    version !== LEGACY_VERSION
    || !ivValue
    || !tagValue
    || !encryptedValue
    || extra
  ) {
    throw new Error('Unsupported encrypted Agent tool secret payload');
  }
  const keyring = normalizeKeyring(
    typeof contextOrLegacyKey === 'string' ? contextOrLegacyKey : keyringValue,
  );
  const candidates = [...new Set(Object.values(keyring.keys))];
  if (candidates.length === 0) throw new AgentToolEncryptionUnavailableError();
  let lastError: unknown;
  for (const keyHex of candidates) {
    try {
      return parsePlaintext(decryptWithKey({
        ivValue,
        tagValue,
        encryptedValue,
        keyHex,
        aad: LEGACY_AAD,
      }));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Agent tool Secret decryption failed');
};

export const inspectAgentToolSecretEnvelope = (
  payload: string,
): AgentToolSecretEnvelopeMetadata => {
  const parts = payload.split('.');
  if (parts[0] === LEGACY_VERSION && parts.length === 4) {
    return { envelopeVersion: 1, keyId: null };
  }
  if (parts[0] === VERSION && parts.length === 5 && KEY_ID.test(parts[1] || '')) {
    return { envelopeVersion: 2, keyId: parts[1] };
  }
  throw new Error('Unsupported encrypted Agent tool secret payload');
};

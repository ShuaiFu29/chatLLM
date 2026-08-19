import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { serverEnv } from './env';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const AAD = Buffer.from('chatllm-agent-tool-secrets', 'utf8');

export class AgentToolEncryptionUnavailableError extends Error {
  constructor() {
    super('Agent tool credential encryption is not configured');
    this.name = 'AgentToolEncryptionUnavailableError';
  }
}

const encryptionKey = (keyHex = serverEnv.AGENT_TOOL_ENCRYPTION_KEY) => {
  if (!keyHex || !/^[a-fA-F0-9]{64}$/.test(keyHex)) {
    throw new AgentToolEncryptionUnavailableError();
  }
  return Buffer.from(keyHex, 'hex');
};

export const encryptAgentToolSecrets = (
  secrets: Record<string, string>,
  keyHex?: string,
) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(keyHex), iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(secrets), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
};

export const decryptAgentToolSecrets = (
  payload: string,
  keyHex?: string,
) => {
  const [version, ivValue, tagValue, encryptedValue, extra] = payload.split('.');
  if (version !== VERSION || !ivValue || !tagValue || !encryptedValue || extra) {
    throw new Error('Unsupported encrypted Agent tool secret payload');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(keyHex),
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Agent tool secret payload');
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== 'string') throw new Error('Invalid Agent tool secret value');
  }
  return parsed as Record<string, string>;
};

import type { AgentMemorySensitivity } from '../repositories/agentMemories';

export type AgentMemorySafetyReason =
  | 'private_key'
  | 'access_token'
  | 'credential_assignment';

export class AgentMemorySafetyError extends Error {
  readonly code = 'AGENT_MEMORY_SENSITIVE_CONTENT';

  constructor(readonly reason: AgentMemorySafetyReason) {
    super('Credentials and authentication secrets cannot be stored in Agent Memory');
    this.name = 'AgentMemorySafetyError';
  }
}

const credentialPatterns: Array<{
  reason: AgentMemorySafetyReason;
  pattern: RegExp;
}> = [
  { reason: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i },
  { reason: 'access_token', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { reason: 'access_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { reason: 'access_token', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { reason: 'access_token', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { reason: 'access_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i },
  {
    reason: 'access_token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    reason: 'credential_assignment',
    pattern: /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|passwd|client[-_ ]?secret|authorization)\s*[:=]\s*["']?[A-Za-z0-9+/_~.-]{8,}/i,
  },
];

const sensitivePersonalPatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:^|\D)1[3-9]\d{9}(?:\D|$)/,
  /(?:^|\D)\d{17}[\dXx](?:\D|$)/,
  /\b(?:\d[ -]?){13,19}\b/,
];

export const inspectAgentMemoryContent = (content: string): {
  sensitivity: AgentMemorySensitivity;
  blockedReason: AgentMemorySafetyReason | null;
} => {
  for (const credential of credentialPatterns) {
    if (credential.pattern.test(content)) {
      return { sensitivity: 'restricted', blockedReason: credential.reason };
    }
  }
  return {
    sensitivity: sensitivePersonalPatterns.some((pattern) => pattern.test(content))
      ? 'sensitive'
      : 'personal',
    blockedReason: null,
  };
};

export const assertAgentMemoryContentSafe = (content: string) => {
  const inspection = inspectAgentMemoryContent(content);
  if (inspection.blockedReason) throw new AgentMemorySafetyError(inspection.blockedReason);
  return inspection;
};

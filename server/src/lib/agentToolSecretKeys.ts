const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const QUERY_NAME = /^[A-Za-z0-9_.~-]+$/;

const RUNTIME_CONTROLLED_HEADERS = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'idempotency-key',
  'keep-alive',
  'mcp-protocol-version',
  'mcp-session-id',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type AgentToolSecretPlacement = Readonly<
  | { kind: 'header'; name: string; normalizedName: string }
  | { kind: 'query'; name: string }
>;

export class AgentToolSecretKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentToolSecretKeyValidationError';
  }
}

const invalid = (message: string): never => {
  throw new AgentToolSecretKeyValidationError(message);
};

/**
 * Resolve one stored Secret key to the only request field it is allowed to
 * control. Keeping this parser shared by the management API and both runtimes
 * prevents a value accepted by one path from gaining wider powers in another.
 */
export const parseAgentToolSecretKey = (key: string): AgentToolSecretPlacement => {
  if (key === 'bearer_token') {
    return { kind: 'header', name: 'Authorization', normalizedName: 'authorization' };
  }
  if (key.startsWith('header:')) {
    const name = key.slice('header:'.length);
    if (!name || name.length > 120 || !HEADER_NAME.test(name)) {
      return invalid(`Invalid Agent tool Secret header key: ${key}`);
    }
    const normalizedName = name.toLowerCase();
    if (
      RUNTIME_CONTROLLED_HEADERS.has(normalizedName)
      || normalizedName.startsWith('proxy-')
      || normalizedName.startsWith('sec-')
    ) {
      return invalid(`Agent runtime-controlled header cannot be stored as a Secret: ${name}`);
    }
    return { kind: 'header', name, normalizedName };
  }
  if (key.startsWith('query:')) {
    const name = key.slice('query:'.length);
    if (!name || name.length > 120 || !QUERY_NAME.test(name)) {
      return invalid(`Invalid Agent tool Secret query key: ${key}`);
    }
    return { kind: 'query', name };
  }
  return invalid(
    `Unsupported Agent tool Secret key: ${key}; use bearer_token, header:Header-Name, or query:param`,
  );
};

export const validateAgentToolSecrets = (
  secrets: Readonly<Record<string, string>>,
): ReadonlyMap<string, AgentToolSecretPlacement> => {
  const placements = new Map<string, AgentToolSecretPlacement>();
  const destinations = new Set<string>();
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value !== 'string') {
      throw new AgentToolSecretKeyValidationError(`Agent tool Secret value must be text: ${key}`);
    }
    const placement = parseAgentToolSecretKey(key);
    const destination = placement.kind === 'header'
      ? `header:${placement.normalizedName}`
      : `query:${placement.name}`;
    if (destinations.has(destination)) {
      throw new AgentToolSecretKeyValidationError(
        `More than one Agent tool Secret targets ${destination}`,
      );
    }
    destinations.add(destination);
    placements.set(key, placement);
  }
  return placements;
};


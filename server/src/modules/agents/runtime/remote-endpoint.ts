import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent as UndiciAgent } from 'undici';
import { AgentToolError } from './agent-tool-error';

const isLoopback = (value: string) => (
  value === 'localhost'
  || value === '127.0.0.1'
  || value === '::1'
  || value === '[::1]'
  || value === '0:0:0:0:0:0:0:1'
);

const isPrivateAddress = (value: string) => {
  const normalized = value.toLowerCase();
  if (isIP(normalized) === 6) {
    if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice('::ffff:'.length));
    return normalized === '::'
      || normalized === '::1'
      || normalized === '0:0:0:0:0:0:0:0'
      || normalized === '0:0:0:0:0:0:0:1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('ff')
      || normalized.startsWith('2001:db8')
      || /^fe[c-f]/.test(normalized);
  }
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0)
    || (first === 192 && second === 2)
    || (first === 192 && second === 88 && octets[2] === 99)
    || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0 && octets[2] === 113)
    || first === 0
    || first >= 224;
};

const splitRule = (rawRule: string) => {
  const rule = rawRule.trim().toLowerCase();
  if (isIP(rule)) return { host: rule, port: undefined };
  if (rule.startsWith('[')) {
    const closing = rule.indexOf(']');
    if (closing >= 0) {
      return { host: rule.slice(1, closing), port: rule.slice(closing + 1).replace(/^:/, '') || undefined };
    }
  }
  const separator = rule.lastIndexOf(':');
  if (separator > 0 && /^\d+$/.test(rule.slice(separator + 1))) {
    return { host: rule.slice(0, separator), port: rule.slice(separator + 1) };
  }
  return { host: rule, port: undefined };
};

export const endpointHostAllowed = (hostname: string, port: string, rules: string[]) => rules.some((rawRule) => {
  const { host, port: rulePort } = splitRule(rawRule);
  const normalized = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return false;
  const hostMatches = host.startsWith('*.')
    ? normalized.endsWith(host.slice(1)) && normalized.length > host.length - 1
    : normalized === host;
  return hostMatches && (!rulePort || rulePort === port);
});

export const assertAllowedRemoteEndpoint = async (input: {
  endpoint: URL;
  rules: string[];
  protocolError: string;
  allowHttpSecretsOnLoopback?: boolean;
  hasSecrets?: boolean;
}) => {
  const { endpoint, rules } = input;
  const hostname = endpoint.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80');
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new AgentToolError('tool_endpoint_unsupported_protocol', input.protocolError);
  }
  if (endpoint.username || endpoint.password) {
    throw new AgentToolError('tool_endpoint_misconfigured', 'Endpoint credentials are not allowed in URLs');
  }
  if (!endpointHostAllowed(hostname, port, rules)) {
    throw new AgentToolError('tool_endpoint_not_allowlisted', 'Remote endpoint is not allowlisted');
  }
  if (
    input.hasSecrets
    && endpoint.protocol === 'http:'
    && !(input.allowHttpSecretsOnLoopback && isLoopback(hostname))
  ) {
    throw new AgentToolError('tool_endpoint_credentials_insecure', 'Credentials require an HTTPS endpoint');
  }

  const addresses = isIP(hostname)
    ? [hostname]
    : (await dns.lookup(hostname, { all: true, verbatim: true })).map((item) => item.address);
  if (addresses.length === 0) {
    throw new AgentToolError('tool_endpoint_misconfigured', 'Remote endpoint did not resolve to an address');
  }
  const blocked = addresses.find((address) => isPrivateAddress(address));
  if (blocked && !addresses.every((address) => endpointHostAllowed(address, port, rules))) {
    throw new AgentToolError(
      'tool_endpoint_blocked_address',
      'Remote endpoint resolves to a private or loopback address',
    );
  }
  return { addresses };
};

/**
 * Pin fetch connections to the addresses checked above. Resolving once for
 * validation and letting a second resolver run inside fetch leaves a DNS
 * rebinding window (especially with wildcard allowlists).
 */
export const createPinnedRemoteEndpointDispatcher = (
  endpoint: URL,
  addresses: string[],
) => {
  const hostname = endpoint.hostname.replace(/^\[/, '').replace(/\]$/, '');
  return new UndiciAgent({
    connect: {
      servername: hostname,
      lookup: (_lookupHostname, options, callback) => {
        const requestedFamily = typeof options === 'object' && options && 'family' in options
          ? Number((options as { family?: unknown }).family || 0)
          : 0;
        const address = addresses.find((candidate) => (
          requestedFamily === 0 || isIP(candidate) === requestedFamily
        ));
        if (!address) {
          callback(
            Object.assign(new Error('Remote endpoint has no address for the requested IP family'), {
              code: 'EAI_FAMILY',
            }),
            '',
            0,
          );
          return;
        }
        callback(null, address, isIP(address));
      },
    },
  });
};

import { decryptAgentToolSecrets } from '../../../lib/agentToolSecrets';
import { serverEnv } from '../../../lib/env';
import type { AgentToolWithSecretsRow } from '../../../repositories/agentTools';
import type { AgentRuntimeTool } from './agent-tool';
import { validateAgentJsonSchemaInput } from './json-schema-input';
import {
  assertAllowedRemoteEndpoint,
  createPinnedRemoteEndpointDispatcher,
} from './remote-endpoint';

interface HttpToolConfiguration {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  timeout_ms: number;
  input_schema: Record<string, unknown>;
  static_headers: Record<string, string>;
  response_path: string;
}

const applySecrets = (
  endpoint: URL,
  headers: Headers,
  encryptedSecrets?: string | null,
) => {
  if (!encryptedSecrets) return;
  const secrets = decryptAgentToolSecrets(encryptedSecrets);
  for (const [key, value] of Object.entries(secrets)) {
    if (key === 'bearer_token') {
      headers.set('Authorization', `Bearer ${value}`);
    } else if (key.startsWith('header:')) {
      const headerName = key.slice('header:'.length);
      const normalized = headerName.toLowerCase();
      if (
        ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade'].includes(normalized)
        || normalized.startsWith('proxy-')
      ) throw new Error('Transport-controlled headers are not allowed');
      headers.set(headerName, value);
    } else if (key.startsWith('query:')) {
      endpoint.searchParams.set(key.slice('query:'.length), value);
    }
  }
};

const prepareRequest = async (
  configuration: HttpToolConfiguration,
  args: Record<string, unknown>,
  encryptedSecrets?: string | null,
) => {
  const endpoint = new URL(configuration.endpoint);
  const fixedQueryKeys = new Set(endpoint.searchParams.keys());
  const { addresses } = await assertAllowedRemoteEndpoint({
    endpoint,
    rules: serverEnv.AGENT_HTTP_ALLOWED_HOSTS,
    protocolError: 'Only HTTP(S) endpoints are supported',
    allowHttpSecretsOnLoopback: true,
    hasSecrets: Boolean(encryptedSecrets),
  });
  const remaining = { ...args };
  endpoint.pathname = endpoint.pathname.replace(/(?:\{|%7B)([A-Za-z_][A-Za-z0-9_]*)(?:\}|%7D)/gi, (_match, key: string) => {
    const value = remaining[key];
    if (value === undefined || value === null) throw new Error(`Missing path parameter: ${key}`);
    delete remaining[key];
    return encodeURIComponent(String(value));
  });

  const headers = new Headers(configuration.static_headers);
  headers.set('Accept', 'application/json, text/plain;q=0.9');

  let body: string | undefined;
  if (configuration.method === 'GET' || configuration.method === 'DELETE') {
    for (const [key, value] of Object.entries(remaining)) {
      if (value !== undefined && value !== null && !fixedQueryKeys.has(key)) {
        endpoint.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
  } else {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(remaining);
  }
  // Credential-bearing query parameters are configuration, not model input.
  // Apply them last so an argument with the same key cannot override a tenant,
  // scope, or signed credential supplied by the tool owner.
  applySecrets(endpoint, headers, encryptedSecrets);
  return { endpoint, headers, body, addresses };
};

const readBoundedResponse = async (response: Response) => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > serverEnv.AGENT_HTTP_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Agent HTTP tool response exceeded its size limit');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
};

const selectResponsePath = (value: unknown, responsePath: string) => {
  if (!responsePath) return value;
  return responsePath.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
};

export const createCustomHttpRuntimeTool = (tool: AgentToolWithSecretsRow): AgentRuntimeTool => {
  const configuration = tool.configuration as unknown as HttpToolConfiguration;
  const effectiveRiskLevel = tool.risk_level === 'read' && configuration.method !== 'GET'
    ? 'write' as const
    : tool.risk_level;
  const modelName = `custom_${tool.id.replace(/-/g, '_')}`;
  return {
    key: `custom:${tool.id}`,
    modelName,
    riskLevel: effectiveRiskLevel,
    definition: {
      type: 'function',
      function: {
        name: modelName,
        description: tool.description || tool.name,
        parameters: configuration.input_schema,
      },
    },
    execute: async (input, context) => {
      const args = validateAgentJsonSchemaInput(input, configuration.input_schema);
      const request = await prepareRequest(configuration, args, tool.encrypted_secrets);
      const dispatcher = createPinnedRemoteEndpointDispatcher(request.endpoint, request.addresses);
      try {
        const response = await fetch(request.endpoint, {
          method: configuration.method,
          headers: request.headers,
          body: request.body,
          redirect: 'error',
          signal: AbortSignal.any([
            context.signal,
            AbortSignal.timeout(configuration.timeout_ms),
          ]),
          dispatcher,
        } as RequestInit & { dispatcher: unknown });
        const rawBody = await readBoundedResponse(response);
        let parsedBody: unknown = rawBody;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.toLowerCase().includes('json') && rawBody) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            throw new Error('Agent HTTP tool returned invalid JSON');
          }
        }
        if (!response.ok) throw new Error(`Agent HTTP tool failed with status ${response.status}`);
        const data = selectResponsePath(parsedBody, configuration.response_path);
        if (configuration.response_path && data === undefined) {
          throw new Error('Agent HTTP tool response path was not found');
        }
        return {
          status: response.status,
          data,
        };
      } finally {
        // The dispatcher is intentionally per request so a checked address is
        // never replaced by a later DNS result from a shared pool.
        await dispatcher.close().catch(() => undefined);
      }
    },
  };
};

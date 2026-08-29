import { serverEnv } from '../../../lib/env';
import type { AgentToolWithSecretsRow } from '../../../repositories/agentTools';
import type { AgentRuntimeTool, AgentToolExecutionContext } from './agent-tool';
import { createAgentApprovalHttpTarget } from './agent-approval-intent';
import { AgentToolError } from './agent-tool-error';
import {
  validateAgentJsonSchemaInput,
  validateAgentJsonSchemaValue,
} from './json-schema-input';
import {
  resolveAgentToolSecretsForUse,
  redactAgentToolSecretValues,
  type AgentToolSecretUseContext,
  type AgentToolSecretAuditWriter,
  type ResolvedAgentToolSecrets,
} from './agent-tool-secret-runtime';
import {
  assertAllowedRemoteEndpoint,
  createPinnedRemoteEndpointDispatcher,
} from './remote-endpoint';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

interface HttpToolConfiguration {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  idempotency_mode: 'none' | 'header';
  timeout_ms: number;
  input_schema: Record<string, unknown>;
  static_headers: Record<string, string>;
  response_path: string;
  output_schema?: Record<string, unknown>;
}

const DEFAULT_CUSTOM_TOOL_DESCRIPTION = 'Custom Agent tool';

const applySecrets = (
  endpoint: URL,
  headers: Headers,
  resolved: ResolvedAgentToolSecrets | null,
) => {
  if (!resolved) return;
  for (const [key, value] of Object.entries(resolved.secrets)) {
    const placement = resolved.placements.get(key);
    if (!placement) throw new AgentToolError('tool_endpoint_misconfigured', 'Invalid Secret placement');
    if (key === 'bearer_token') {
      headers.set(placement.name, `Bearer ${value}`);
    } else if (placement.kind === 'header') {
      headers.set(placement.name, value);
    } else {
      endpoint.searchParams.set(placement.name, value);
    }
  }
};

const prepareRequest = async (
  configuration: HttpToolConfiguration,
  args: Record<string, unknown>,
  resolvedSecrets: ResolvedAgentToolSecrets | null,
  hasSecrets: boolean,
  idempotencyKey?: string,
) => {
  const endpoint = new URL(configuration.endpoint);
  const fixedQueryKeys = new Set(endpoint.searchParams.keys());
  const { addresses } = await assertAllowedRemoteEndpoint({
    endpoint,
    rules: serverEnv.AGENT_HTTP_ALLOWED_HOSTS,
    protocolError: 'Only HTTP(S) endpoints are supported',
    allowHttpSecretsOnLoopback: true,
    hasSecrets,
  });
  // Only fields the tool author declared may reach the endpoint. The input schema
  // rejects undeclared keys when it sets `additionalProperties: false`, but that is
  // opt-in: an author who omits it would otherwise hand the model the ability to
  // add arbitrary query parameters or body fields to their own API. Filtering here
  // makes the declared schema the contract regardless of how it was written.
  const declaredProperties = isRecord(configuration.input_schema.properties)
    ? new Set(Object.keys(configuration.input_schema.properties))
    : null;
  const remaining: Record<string, unknown> = declaredProperties
    ? Object.fromEntries(
      Object.entries(args).filter(([key]) => declaredProperties.has(key)),
    )
    : { ...args };
  endpoint.pathname = endpoint.pathname.replace(/(?:\{|%7B)([A-Za-z_][A-Za-z0-9_]*)(?:\}|%7D)/gi, (_match, key: string) => {
    const value = remaining[key];
    if (value === undefined || value === null) {
      throw new AgentToolError('tool_input_invalid', `Missing path parameter: ${key}`);
    }
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
  applySecrets(endpoint, headers, resolvedSecrets);
  // This header is a runtime proof, not user configuration. It is sent only when
  // the tool owner explicitly says the endpoint de-duplicates this operation,
  // and it is applied after every configured header so it cannot be replaced by
  // a static value or an encrypted secret.
  if (configuration.idempotency_mode === 'header' && idempotencyKey) {
    headers.set('Idempotency-Key', idempotencyKey);
  }
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
      throw new AgentToolError(
        'tool_response_too_large',
        'Agent HTTP tool response exceeded its size limit',
        { limitBytes: serverEnv.AGENT_HTTP_MAX_RESPONSE_BYTES },
      );
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

export type CustomHttpExecutionContext = Pick<
  AgentToolExecutionContext,
  'signal' | 'idempotencyKey'
> & AgentToolSecretUseContext;

export const executeCustomHttpToolRequest = async (input: {
  tool: AgentToolWithSecretsRow;
  arguments: unknown;
  context: CustomHttpExecutionContext;
  recordSecretEvent?: AgentToolSecretAuditWriter;
  onRequestStart?: () => void;
  redactResponseSecrets?: boolean;
}) => {
  const configuration = input.tool.configuration as unknown as HttpToolConfiguration;
  const args = validateAgentJsonSchemaInput(input.arguments, configuration.input_schema);
  const resolvedSecrets = await resolveAgentToolSecretsForUse({
    tool: input.tool,
    context: input.context,
    recordEvent: input.recordSecretEvent,
  });
  const request = await prepareRequest(
    configuration,
    args,
    resolvedSecrets,
    Boolean(input.tool.encrypted_secrets),
    input.context.idempotencyKey,
  );
  const dispatcher = createPinnedRemoteEndpointDispatcher(request.endpoint, request.addresses);
  try {
    input.onRequestStart?.();
    const response = await fetch(request.endpoint, {
      method: configuration.method,
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      signal: AbortSignal.any([
        input.context.signal,
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
        throw new AgentToolError(
          'tool_response_invalid_json',
          'Agent HTTP tool returned invalid JSON',
        );
      }
    }
    if (!response.ok) {
      throw new AgentToolError(
        'tool_http_status',
        `Agent HTTP tool failed with status ${response.status}`,
        { status: response.status },
      );
    }
    const selectedData = selectResponsePath(parsedBody, configuration.response_path);
    if (configuration.response_path && selectedData === undefined) {
      throw new AgentToolError(
        'tool_response_path_missing',
        'Agent HTTP tool response path was not found',
        { responsePath: configuration.response_path },
      );
    }
    if (configuration.output_schema) {
      try {
        validateAgentJsonSchemaValue(
          selectedData,
          configuration.output_schema,
          'tool output',
          { allowPattern: true },
        );
      } catch (error) {
        throw new AgentToolError(
          'tool_output_invalid',
          'Agent HTTP tool response did not match its Output Schema',
          { cause: error instanceof Error ? error.message : 'Output Schema mismatch' },
        );
      }
    }
    const data = input.redactResponseSecrets && resolvedSecrets
      ? redactAgentToolSecretValues(selectedData, resolvedSecrets.secrets)
      : selectedData;
    return {
      status: response.status,
      data,
    };
  } finally {
    // The dispatcher is intentionally per request so a checked address is
    // never replaced by a later DNS result from a shared pool.
    await dispatcher.close().catch(() => undefined);
  }
};

export const createCustomHttpRuntimeTool = (
  tool: AgentToolWithSecretsRow,
  adapters: { recordSecretEvent?: AgentToolSecretAuditWriter } = {},
): AgentRuntimeTool => {
  const configuration = tool.configuration as unknown as HttpToolConfiguration;
  const effectiveRiskLevel = tool.risk_level === 'read' && configuration.method !== 'GET'
    ? 'write' as const
    : tool.risk_level;
  const retryMode = configuration.method === 'GET' && effectiveRiskLevel === 'read'
    ? 'safe_read' as const
    : configuration.idempotency_mode === 'header'
      ? 'idempotent_write' as const
      : 'never' as const;
  const modelName = `custom_${tool.id.replace(/-/g, '_')}`;
  return {
    key: `custom:${tool.id}`,
    modelName,
    riskLevel: effectiveRiskLevel,
    retryMode,
    maxInvocationsPerRun: tool.max_invocations_per_run ?? undefined,
    describeApproval: (args) => ({
      kind: 'http',
      toolVersionId: tool.tool_version_id,
      configurationHash: tool.configuration_hash,
      secretVersion: tool.secret_version,
      target: createAgentApprovalHttpTarget(configuration.endpoint, args),
      method: configuration.method,
      sideEffectSummary: configuration.method === 'GET'
        ? 'Read data from the configured HTTP endpoint.'
        : `Send an HTTP ${configuration.method} request; this may change state in the configured external system.`,
    }),
    definition: {
      type: 'function',
      function: {
        name: modelName,
        // The display name is mutable metadata and is intentionally not part of
        // an executable tool version. Falling back to it would let a rename
        // silently change a published Agent's model-visible tool definition.
        description: tool.description || DEFAULT_CUSTOM_TOOL_DESCRIPTION,
        parameters: configuration.input_schema,
      },
    },
    execute: (input, context) => executeCustomHttpToolRequest({
      tool,
      arguments: input,
      context,
      recordSecretEvent: adapters.recordSecretEvent,
    }),
  };
};

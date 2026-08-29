import { serverEnv } from '../../../lib/env';
import type { AgentToolWithSecretsRow } from '../../../repositories/agentTools';
import type { AgentRuntimeTool, AgentToolExecutionContext } from './agent-tool';
import { createAgentApprovalHttpTarget } from './agent-approval-intent';
import { AgentToolError } from './agent-tool-error';
import {
  validateAgentJsonObjectSchemaDefinition,
  validateAgentJsonSchemaDefinition,
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

interface McpToolConfiguration {
  endpoint: string;
  tool_name: string;
  timeout_ms: number;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

const DEFAULT_CUSTOM_TOOL_DESCRIPTION = 'Custom Agent tool';
const MAX_DISCOVERY_PAGES = 10;
const MAX_DISCOVERED_TOOLS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const MCP_PROTOCOL_VERSION = '2025-06-18';

const applyMcpSecrets = (endpoint: URL, resolved: ResolvedAgentToolSecrets | null) => {
  const headers = new Headers();
  if (!resolved) return headers;
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
  return headers;
};

const readBoundedResponse = async (response: Response) => {
  if (!response.body) return '';
  const maximum = serverEnv.AGENT_HTTP_MAX_RESPONSE_BYTES;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new AgentToolError(
        'tool_response_too_large',
        'Agent MCP response exceeded its size limit',
        { limitBytes: maximum },
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

const readSseJsonRpcResult = async (
  response: Response,
  id: number,
) => {
  if (!response.body) {
    throw new AgentToolError('tool_mcp_protocol_error', 'Remote MCP endpoint returned an empty response');
  }
  const maximum = serverEnv.AGENT_HTTP_MAX_RESPONSE_BYTES;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;

  const processEvent = (event: string): unknown | undefined => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    if (!data || data === '[DONE]') return undefined;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(data) as JsonRpcMessage;
    } catch {
      throw new AgentToolError('tool_response_invalid_json', 'Remote MCP endpoint returned malformed JSON');
    }
    if (message.id !== id) return undefined;
    if (message.error) {
      throw new AgentToolError(
        'tool_mcp_protocol_error',
        'Remote MCP endpoint returned a protocol error',
        { rpcCode: message.error.code },
      );
    }
    return { matched: true, result: message.result };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        throw new AgentToolError(
          'tool_response_too_large',
          'Agent MCP response exceeded its size limit',
          { limitBytes: maximum },
        );
      }
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const lfSeparator = buffer.indexOf('\n\n');
        const crlfSeparator = buffer.indexOf('\r\n\r\n');
        let separator = -1;
        let separatorLength = 0;
        if (lfSeparator >= 0 && (crlfSeparator < 0 || lfSeparator < crlfSeparator)) {
          separator = lfSeparator;
          separatorLength = 2;
        } else if (crlfSeparator >= 0) {
          separator = crlfSeparator;
          separatorLength = 4;
        }
        if (separator < 0) break;
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + separatorLength);
        const processed = processEvent(event);
        if (processed && typeof processed === 'object' && (processed as { matched?: boolean }).matched) {
          return (processed as { result: unknown }).result;
        }
      }
    }
    buffer += decoder.decode();
    const processed = processEvent(buffer);
    if (processed && typeof processed === 'object' && (processed as { matched?: boolean }).matched) {
      return (processed as { result: unknown }).result;
    }
    throw new AgentToolError('tool_mcp_protocol_error', 'Remote MCP endpoint returned no matching response');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

const parseJsonRpcMessages = (body: string, contentType: string): JsonRpcMessage[] => {
  if (!body.trim()) return [];
  try {
    if (contentType.toLowerCase().includes('text/event-stream')) {
      return body
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line && line !== '[DONE]')
        .map((line) => JSON.parse(line) as JsonRpcMessage);
    }
    const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new AgentToolError('tool_response_invalid_json', 'Remote MCP endpoint returned malformed JSON');
  }
};

const readJsonRpcResult = (
  messages: JsonRpcMessage[],
  id: number,
) => {
  const message = messages.find((item) => item.id === id);
  if (!message) {
    throw new AgentToolError('tool_mcp_protocol_error', 'Remote MCP endpoint returned no matching response');
  }
  if (message.error) {
    throw new AgentToolError(
      'tool_mcp_protocol_error',
      'Remote MCP endpoint returned a protocol error',
      { rpcCode: message.error.code },
    );
  }
  return message.result;
};

type McpSessionContext = Pick<AgentToolExecutionContext, 'signal'> & AgentToolSecretUseContext;
type McpSessionSend = (
  payload: Record<string, unknown>,
  id?: number,
) => Promise<unknown>;

const withCustomMcpSession = async <T>(input: {
  tool: AgentToolWithSecretsRow;
  context: McpSessionContext;
  recordSecretEvent?: AgentToolSecretAuditWriter;
  clientName: string;
  onRequestStart?: () => void;
  run: (session: {
    send: McpSessionSend;
    initializeResult: unknown;
    redactSecrets: (value: unknown) => unknown;
  }) => Promise<T>;
}) => {
  const configuration = input.tool.configuration as unknown as McpToolConfiguration;
  const endpoint = new URL(configuration.endpoint);
  const { addresses } = await assertAllowedRemoteEndpoint({
    endpoint,
    rules: serverEnv.AGENT_MCP_ALLOWED_HOSTS,
    protocolError: 'Only remote HTTP MCP endpoints are supported',
    allowHttpSecretsOnLoopback: true,
    hasSecrets: Boolean(input.tool.encrypted_secrets),
  });
  const resolvedSecrets = await resolveAgentToolSecretsForUse({
    tool: input.tool,
    context: input.context,
    recordEvent: input.recordSecretEvent,
  });
  const secretHeaders = applyMcpSecrets(endpoint, resolvedSecrets);
  const dispatcher = createPinnedRemoteEndpointDispatcher(endpoint, addresses);
  const signal = AbortSignal.any([
    input.context.signal,
    AbortSignal.timeout(configuration.timeout_ms),
  ]);
  let sessionId = '';

  const send: McpSessionSend = async (payload, id) => {
    const headers = new Headers(secretHeaders);
    headers.set('Accept', 'application/json, text/event-stream');
    headers.set('Content-Type', 'application/json');
    headers.set('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
    if (sessionId) headers.set('MCP-Session-Id', sessionId);
    input.onRequestStart?.();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'error',
      signal,
      dispatcher,
    } as RequestInit & { dispatcher: unknown });
    const responseSessionId = response.headers.get('mcp-session-id');
    if (responseSessionId) sessionId = responseSessionId;
    if (!response.ok) {
      throw new AgentToolError(
        'tool_http_status',
        `Remote MCP endpoint failed with status ${response.status}`,
        { status: response.status },
      );
    }
    const contentType = response.headers.get('content-type') || '';
    if (id === undefined) {
      // Notifications may still receive a response body. Consume it so undici
      // can reuse the connection instead of leaking the socket.
      if (contentType.toLowerCase().includes('text/event-stream')) {
        await response.body?.cancel().catch(() => undefined);
      } else {
        await readBoundedResponse(response);
      }
      return undefined;
    }
    if (contentType.toLowerCase().includes('text/event-stream')) {
      return readSseJsonRpcResult(response, id);
    }
    const body = await readBoundedResponse(response);
    return readJsonRpcResult(parseJsonRpcMessages(body, contentType), id);
  };

  try {
    const initializeResult = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: input.clientName, version: '1.0.0' },
      },
    }, 1);
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return await input.run({
      send,
      initializeResult,
      redactSecrets: (value) => resolvedSecrets
        ? redactAgentToolSecretValues(value, resolvedSecrets.secrets)
        : value,
    });
  } finally {
    if (sessionId) {
      const headers = new Headers(secretHeaders);
      headers.set('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
      headers.set('MCP-Session-Id', sessionId);
      const cleanupResponse = await fetch(endpoint, {
        method: 'DELETE',
        headers,
        redirect: 'error',
        // Cleanup must still run after the operation is cancelled. It uses an
        // independent short timeout rather than the already-aborted signal.
        signal: AbortSignal.timeout(Math.min(configuration.timeout_ms, 2000)),
        dispatcher,
      } as RequestInit & { dispatcher: unknown }).catch(() => undefined);
      if (cleanupResponse) await readBoundedResponse(cleanupResponse).catch(() => undefined);
    }
    await dispatcher.close().catch(() => undefined);
  }
};

export interface DiscoveredMcpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

export interface CustomMcpDiscoveryResult {
  protocol_version: string | null;
  server_info: { name: string; version: string } | null;
  capability_names: string[];
  tools: DiscoveredMcpTool[];
  selected_tool_found: boolean;
  truncated: boolean;
  warnings: string[];
}

const boundedMcpTool = (
  value: unknown,
  warnings: string[],
): DiscoveredMcpTool | null => {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const name = value.name.trim();
  if (!name || name.length > 160) return null;
  let inputSchema: Record<string, unknown> = { type: 'object', properties: {} };
  if (value.inputSchema !== undefined) {
    if (isRecord(value.inputSchema)) {
      try {
        validateAgentJsonObjectSchemaDefinition(value.inputSchema, { allowPattern: true });
        inputSchema = value.inputSchema;
      } catch {
        warnings.push(`Invalid Input Schema omitted for MCP tool: ${name}`);
      }
    } else {
      warnings.push(`Invalid Input Schema omitted for MCP tool: ${name}`);
    }
  }
  let outputSchema: Record<string, unknown> | undefined;
  if (value.outputSchema !== undefined) {
    if (isRecord(value.outputSchema)) {
      try {
        validateAgentJsonSchemaDefinition(value.outputSchema, { allowPattern: true });
        outputSchema = value.outputSchema;
      } catch {
        warnings.push(`Invalid Output Schema omitted for MCP tool: ${name}`);
      }
    } else {
      warnings.push(`Invalid Output Schema omitted for MCP tool: ${name}`);
    }
  }
  return {
    name,
    description: typeof value.description === 'string'
      ? value.description.slice(0, 4000)
      : '',
    input_schema: inputSchema,
    ...(outputSchema ? { output_schema: outputSchema } : {}),
  };
};

/**
 * MCP discovery performs only initialize, initialized and tools/list. It never
 * calls tools/call, so an editor can inspect a server without executing the
 * configured remote capability.
 */
export const discoverCustomMcpTools = async (input: {
  tool: AgentToolWithSecretsRow;
  context: McpSessionContext;
  recordSecretEvent?: AgentToolSecretAuditWriter;
  onRequestStart?: () => void;
}): Promise<CustomMcpDiscoveryResult> => withCustomMcpSession({
  ...input,
  clientName: 'chatllm-agent-tool-diagnostics',
  run: async ({ send, initializeResult, redactSecrets }) => {
    const redactedInitialize = redactSecrets(initializeResult);
    const initialize = isRecord(redactedInitialize) ? redactedInitialize : {};
    const serverInfo = isRecord(initialize.serverInfo) ? initialize.serverInfo : null;
    const capabilities = isRecord(initialize.capabilities) ? initialize.capabilities : {};
    const warnings: string[] = [];
    const tools: DiscoveredMcpTool[] = [];
    const names = new Set<string>();
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
      const id = page + 2;
      const rawResult = await send({
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      }, id);
      const result = redactSecrets(rawResult);
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new AgentToolError(
          'tool_mcp_protocol_error',
          'Remote MCP tools/list returned an invalid result',
        );
      }
      for (const rawTool of result.tools) {
        const tool = boundedMcpTool(rawTool, warnings);
        if (!tool) {
          warnings.push('A malformed MCP tool definition was omitted.');
          continue;
        }
        if (names.has(tool.name)) {
          warnings.push(`Duplicate MCP tool omitted: ${tool.name}`);
          continue;
        }
        names.add(tool.name);
        tools.push(tool);
        if (tools.length >= MAX_DISCOVERED_TOOLS) {
          truncated = true;
          break;
        }
      }
      const nextCursor = typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : undefined;
      if (truncated || !nextCursor) break;
      cursor = nextCursor;
      if (page === MAX_DISCOVERY_PAGES - 1) truncated = true;
    }
    if (truncated) warnings.push('Discovery stopped at the configured pagination limit.');
    const configuration = input.tool.configuration as unknown as McpToolConfiguration;
    return {
      protocol_version: typeof initialize.protocolVersion === 'string'
        ? initialize.protocolVersion.slice(0, 80)
        : null,
      server_info: serverInfo
        ? {
          name: typeof serverInfo.name === 'string' ? serverInfo.name.slice(0, 200) : '',
          version: typeof serverInfo.version === 'string' ? serverInfo.version.slice(0, 100) : '',
        }
        : null,
      capability_names: Object.keys(capabilities).slice(0, 50),
      tools,
      selected_tool_found: names.has(configuration.tool_name),
      truncated,
      warnings: [...new Set(warnings)].slice(0, 20),
    };
  },
});

export const createCustomMcpRuntimeTool = (
  tool: AgentToolWithSecretsRow,
  adapters: { recordSecretEvent?: AgentToolSecretAuditWriter } = {},
): AgentRuntimeTool => {
  const configuration = tool.configuration as unknown as McpToolConfiguration;
  const inputSchema = configuration.input_schema || { type: 'object', properties: {} };
  const modelName = `custom_${tool.id.replace(/-/g, '_')}`;
  const effectiveRiskLevel = tool.risk_level === 'read' ? 'write' as const : tool.risk_level;

  return {
    key: `custom:${tool.id}`,
    modelName,
    riskLevel: effectiveRiskLevel,
    // Remote MCP does not expose a universal idempotency contract for tools/call.
    // A transport retry could execute an arbitrary side effect twice.
    retryMode: 'never',
    maxInvocationsPerRun: tool.max_invocations_per_run ?? undefined,
    describeApproval: (args) => ({
      kind: 'mcp',
      toolVersionId: tool.tool_version_id,
      configurationHash: tool.configuration_hash,
      secretVersion: tool.secret_version,
      target: createAgentApprovalHttpTarget(configuration.endpoint, args),
      method: `tools/call:${configuration.tool_name}`,
      sideEffectSummary: 'Call the configured remote MCP tool; the remote tool may read or change external state.',
    }),
    definition: {
      type: 'function',
      function: {
        name: modelName,
        // Keep the model-visible contract independent from mutable catalog
        // metadata. A rename must not mutate a pinned Agent tool definition.
        description: tool.description || DEFAULT_CUSTOM_TOOL_DESCRIPTION,
        parameters: inputSchema,
      },
    },
    execute: async (input, context) => {
      const args = validateAgentJsonSchemaInput(input, inputSchema);
      return withCustomMcpSession({
        tool,
        context,
        recordSecretEvent: adapters.recordSecretEvent,
        clientName: 'chatllm-agent-runtime',
        run: async ({ send }) => {
          const result = await send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: configuration.tool_name, arguments: args },
          }, 2);
          if (result && typeof result === 'object' && (result as { isError?: unknown }).isError === true) {
            // MCP uses a successful JSON-RPC envelope with isError=true for a
            // tool-level failure. Do not expose it as a successful tool step.
            throw new AgentToolError('tool_reported_error', 'Remote MCP tool reported an execution error');
          }
          if (configuration.output_schema) {
            try {
              const outputValue = isRecord(result) && result.structuredContent !== undefined
                ? result.structuredContent
                : result;
              validateAgentJsonSchemaValue(
                outputValue,
                configuration.output_schema,
                'tool output',
                { allowPattern: true },
              );
            } catch (error) {
              throw new AgentToolError(
                'tool_output_invalid',
                'Remote MCP tool result did not match its Output Schema',
                { cause: error instanceof Error ? error.message : 'Output Schema mismatch' },
              );
            }
          }
          return result;
        },
      });
    },
  };
};

import { decryptAgentToolSecrets } from '../../../lib/agentToolSecrets';
import { serverEnv } from '../../../lib/env';
import type { AgentToolWithSecretsRow } from '../../../repositories/agentTools';
import type { AgentRuntimeTool } from './agent-tool';
import { validateAgentJsonSchemaInput } from './json-schema-input';
import {
  assertAllowedRemoteEndpoint,
  createPinnedRemoteEndpointDispatcher,
} from './remote-endpoint';

interface McpToolConfiguration {
  endpoint: string;
  tool_name: string;
  timeout_ms: number;
  input_schema?: Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const MCP_PROTOCOL_VERSION = '2025-06-18';

const applyMcpSecrets = (endpoint: URL, encryptedSecrets?: string | null) => {
  const headers = new Headers();
  if (!encryptedSecrets) return headers;
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
      throw new Error('Agent MCP response exceeded its size limit');
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
  if (!response.body) throw new Error('Remote MCP endpoint returned an empty response');
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
    const message = JSON.parse(data) as JsonRpcMessage;
    if (message.id !== id) return undefined;
    if (message.error) throw new Error('Remote MCP endpoint returned a protocol error');
    return { matched: true, result: message.result };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Agent MCP response exceeded its size limit');
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
    throw new Error('Remote MCP endpoint returned no matching response');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

const parseJsonRpcMessages = (body: string, contentType: string): JsonRpcMessage[] => {
  if (!body.trim()) return [];
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
};

const readJsonRpcResult = (
  messages: JsonRpcMessage[],
  id: number,
) => {
  const message = messages.find((item) => item.id === id);
  if (!message) throw new Error('Remote MCP endpoint returned no matching response');
  if (message.error) throw new Error('Remote MCP endpoint returned a protocol error');
  return message.result;
};

export const createCustomMcpRuntimeTool = (tool: AgentToolWithSecretsRow): AgentRuntimeTool => {
  const configuration = tool.configuration as unknown as McpToolConfiguration;
  const inputSchema = configuration.input_schema || { type: 'object', properties: {} };
  const modelName = `custom_${tool.id.replace(/-/g, '_')}`;
  const effectiveRiskLevel = tool.risk_level === 'read' ? 'write' as const : tool.risk_level;

  return {
    key: `custom:${tool.id}`,
    modelName,
    riskLevel: effectiveRiskLevel,
    definition: {
      type: 'function',
      function: {
        name: modelName,
        description: tool.description || tool.name,
        parameters: inputSchema,
      },
    },
    execute: async (input, context) => {
      const args = validateAgentJsonSchemaInput(input, inputSchema);
      const endpoint = new URL(configuration.endpoint);
      const { addresses } = await assertAllowedRemoteEndpoint({
        endpoint,
        rules: serverEnv.AGENT_MCP_ALLOWED_HOSTS,
        protocolError: 'Only remote HTTP MCP endpoints are supported',
        allowHttpSecretsOnLoopback: true,
        hasSecrets: Boolean(tool.encrypted_secrets),
      });
      const dispatcher = createPinnedRemoteEndpointDispatcher(endpoint, addresses);
      const secretHeaders = applyMcpSecrets(endpoint, tool.encrypted_secrets);
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(configuration.timeout_ms),
      ]);
      let sessionId = '';

      const send = async (payload: Record<string, unknown>, id?: number) => {
        const headers = new Headers(secretHeaders);
        headers.set('Accept', 'application/json, text/event-stream');
        headers.set('Content-Type', 'application/json');
        headers.set('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
        if (sessionId) headers.set('MCP-Session-Id', sessionId);
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
        if (!response.ok) throw new Error(`Remote MCP endpoint failed with status ${response.status}`);
        const contentType = response.headers.get('content-type') || '';
        if (id === undefined) {
          // Notifications may still receive a response body. Consume it so
          // undici can reuse the connection instead of leaking the socket.
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
        const messages = parseJsonRpcMessages(body, contentType);
        return readJsonRpcResult(messages, id);
      };

      try {
        await send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'chatllm-agent-runtime', version: '1.0.0' },
          },
        }, 1);
        await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const result = await send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: configuration.tool_name, arguments: args },
        }, 2);
        if (result && typeof result === 'object' && (result as { isError?: unknown }).isError === true) {
          // MCP uses a successful JSON-RPC envelope with isError=true for a
          // tool-level failure. Do not record or expose this as a successful
          // Agent tool step.
          throw new Error('Remote MCP tool reported an execution error');
        }
        return result;
      } finally {
        if (sessionId) {
          const headers = new Headers(secretHeaders);
          headers.set('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
          headers.set('MCP-Session-Id', sessionId);
          const cleanupResponse = await fetch(endpoint, {
            method: 'DELETE',
            headers,
            redirect: 'error',
            // Cleanup must still run after the operation is cancelled. It uses
            // an independent short timeout rather than the already-aborted
            // request signal.
            signal: AbortSignal.timeout(Math.min(configuration.timeout_ms, 2000)),
            dispatcher,
          } as RequestInit & { dispatcher: unknown }).catch(() => undefined);
          if (cleanupResponse) {
            await readBoundedResponse(cleanupResponse).catch(() => undefined);
          }
        }
        await dispatcher.close().catch(() => undefined);
      }
    },
  };
};

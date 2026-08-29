import { isIP } from 'node:net';
import { serverEnv } from '../../../lib/env';
import { inspectAgentToolSecretEnvelope } from '../../../lib/agentToolSecrets';
import { hashAgentApprovalJson } from './agent-approval-intent';
import type { AgentToolWithSecretsRow } from '../../../repositories/agentTools';
import type { AgentToolSecretAuditWriter } from './agent-tool-secret-runtime';
import {
  classifyAgentToolError,
  type AgentToolErrorCode,
} from './agent-tool-error';
import { executeCustomHttpToolRequest } from './custom-http-tool';
import {
  discoverCustomMcpTools,
  type CustomMcpDiscoveryResult,
} from './custom-mcp-tool';
import {
  assertAllowedRemoteEndpoint,
  endpointHostAllowed,
} from './remote-endpoint';

export type AgentToolDiagnosticOperation = 'preflight' | 'safe_test' | 'discover';
export type AgentToolDiagnosticCheckStatus = 'passed' | 'warning' | 'failed';

export interface AgentToolDiagnosticCheck {
  key: 'configuration' | 'allowlist' | 'dns' | 'transport' | 'credentials' | 'operation_safety';
  status: AgentToolDiagnosticCheckStatus;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AgentToolResponsePreview {
  data: unknown;
  truncated: boolean;
  original_bytes: number;
  encoding: 'json' | 'json-prefix';
}

export interface AgentToolDiagnosticResult {
  tool_id: string;
  tool_version_id: string;
  configuration_hash: string;
  operation: AgentToolDiagnosticOperation;
  status: 'passed' | 'failed';
  live_request_attempted: boolean;
  checked_at: string;
  duration_ms: number;
  input_hash: string | null;
  checks: AgentToolDiagnosticCheck[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
  response?: { status: number; preview: AgentToolResponsePreview };
  discovery?: CustomMcpDiscoveryResult;
}

export interface AgentToolDiagnosticAuditEvent {
  phase: 'started' | 'completed';
  operation: AgentToolDiagnosticOperation;
  inputHash: string | null;
  liveRequestAttempted: boolean;
  status?: 'passed' | 'failed';
  errorCode?: string;
  durationMs?: number;
}

const PREVIEW_BYTES = 32 * 1024;

const previewValue = (value: unknown): AgentToolResponsePreview => {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= PREVIEW_BYTES) {
    return { data: value, truncated: false, original_bytes: bytes, encoding: 'json' };
  }
  // A prefix is deliberately returned as text instead of pretending a cut JSON
  // document is parseable. The full upstream body is neither persisted nor
  // copied into the diagnostic audit event.
  let prefix = json.slice(0, PREVIEW_BYTES);
  while (Buffer.byteLength(prefix, 'utf8') > PREVIEW_BYTES) prefix = prefix.slice(0, -1);
  return {
    data: prefix,
    truncated: true,
    original_bytes: bytes,
    encoding: 'json-prefix',
  };
};

const check = (
  key: AgentToolDiagnosticCheck['key'],
  status: AgentToolDiagnosticCheckStatus,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AgentToolDiagnosticCheck => ({ key, status, code, message, ...(details ? { details } : {}) });

const diagnosticError = (error: unknown) => {
  const classified = classifyAgentToolError(error);
  return {
    code: classified.code,
    message: classified.message,
    ...(classified.details ? { details: classified.details } : {}),
  };
};

const preflight = async (tool: AgentToolWithSecretsRow) => {
  const checks: AgentToolDiagnosticCheck[] = [];
  let endpoint: URL;
  try {
    endpoint = new URL(String(tool.configuration.endpoint || ''));
    checks.push(check(
      'configuration',
      'passed',
      'configuration_valid',
      'The pinned tool configuration is structurally valid.',
      { kind: tool.kind, tool_version: tool.tool_version },
    ));
  } catch {
    checks.push(check(
      'configuration',
      'failed',
      'tool_endpoint_misconfigured',
      'The pinned tool endpoint is invalid.',
    ));
    return checks;
  }

  const rules = tool.kind === 'mcp'
    ? serverEnv.AGENT_MCP_ALLOWED_HOSTS
    : serverEnv.AGENT_HTTP_ALLOWED_HOSTS;
  const port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80');
  if (!endpointHostAllowed(endpoint.hostname, port, rules)) {
    checks.push(check(
      'allowlist',
      'failed',
      'tool_endpoint_not_allowlisted',
      'The endpoint host and port are not present in the server allowlist.',
      { host: endpoint.hostname, port },
    ));
  } else {
    checks.push(check(
      'allowlist',
      'passed',
      'endpoint_allowlisted',
      'The endpoint host and port match the server allowlist.',
      { host: endpoint.hostname, port },
    ));
  }

  try {
    const { addresses } = await assertAllowedRemoteEndpoint({
      endpoint,
      rules,
      protocolError: tool.kind === 'mcp'
        ? 'Only remote HTTP MCP endpoints are supported'
        : 'Only HTTP(S) endpoints are supported',
      allowHttpSecretsOnLoopback: true,
      hasSecrets: Boolean(tool.encrypted_secrets),
    });
    checks.push(check(
      'dns',
      'passed',
      'endpoint_resolved',
      'DNS resolution and private-address policy passed.',
      {
        address_count: addresses.length,
        address_families: [...new Set(addresses.map((address) => `ipv${isIP(address)}`))],
      },
    ));
  } catch (error) {
    const failure = diagnosticError(error);
    checks.push(check('dns', 'failed', failure.code, failure.message, failure.details));
  }

  checks.push(check(
    'transport',
    endpoint.protocol === 'https:' ? 'passed' : 'warning',
    endpoint.protocol === 'https:' ? 'https_enabled' : 'unencrypted_transport',
    endpoint.protocol === 'https:'
      ? 'The endpoint uses HTTPS.'
      : 'The endpoint uses HTTP; credentials are permitted only for explicit loopback development.',
  ));

  if (tool.encrypted_secrets) {
    try {
      const envelope = inspectAgentToolSecretEnvelope(tool.encrypted_secrets);
      checks.push(check(
        'credentials',
        'passed',
        'credential_envelope_present',
        'An encrypted credential envelope is configured. Its contents were not decrypted by preflight.',
        { envelope_version: envelope.envelopeVersion, key_id: envelope.keyId },
      ));
    } catch {
      checks.push(check(
        'credentials',
        'failed',
        'tool_secret_decryption_failed',
        'The stored credential envelope format is invalid.',
      ));
    }
  } else {
    checks.push(check(
      'credentials',
      'passed',
      'credentials_not_configured',
      'This tool has no stored credentials.',
    ));
  }

  const method = typeof tool.configuration.method === 'string'
    ? tool.configuration.method
    : null;
  const safeHttpRead = tool.kind === 'http' && method === 'GET' && tool.risk_level === 'read';
  checks.push(check(
    'operation_safety',
    safeHttpRead || tool.kind === 'mcp' ? 'passed' : 'warning',
    safeHttpRead
      ? 'safe_http_get_available'
      : tool.kind === 'mcp'
        ? 'mcp_discovery_available'
        : 'live_test_blocked_for_write',
    safeHttpRead
      ? 'A live test is allowed because the pinned operation is a read-risk HTTP GET.'
      : tool.kind === 'mcp'
        ? 'MCP discovery may initialize a session and list tools, but it will never call tools/call.'
        : 'Live testing is blocked for non-GET or non-read HTTP tools.',
  ));
  return checks;
};

const failedResult = (input: {
  tool: AgentToolWithSecretsRow;
  operation: AgentToolDiagnosticOperation;
  startedAt: number;
  inputHash: string | null;
  checks: AgentToolDiagnosticCheck[];
  liveRequestAttempted: boolean;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): AgentToolDiagnosticResult => ({
  tool_id: input.tool.id,
  tool_version_id: input.tool.tool_version_id,
  configuration_hash: input.tool.configuration_hash,
  operation: input.operation,
  status: 'failed',
  live_request_attempted: input.liveRequestAttempted,
  checked_at: new Date().toISOString(),
  duration_ms: Date.now() - input.startedAt,
  input_hash: input.inputHash,
  checks: input.checks,
  error: {
    code: input.code,
    message: input.message,
    ...(input.details ? { details: input.details } : {}),
  },
});

export const runAgentToolDiagnostic = async (input: {
  tool: AgentToolWithSecretsRow;
  operation: AgentToolDiagnosticOperation;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
  recordSecretEvent?: AgentToolSecretAuditWriter;
  recordDiagnosticEvent?: (event: AgentToolDiagnosticAuditEvent) => Promise<void>;
}): Promise<AgentToolDiagnosticResult> => {
  const startedAt = Date.now();
  const inputHash = input.operation === 'safe_test'
    ? hashAgentApprovalJson(input.arguments || {})
    : null;
  const checks = await preflight(input.tool);
  const preflightFailure = checks.find((item) => item.status === 'failed');
  if (preflightFailure) {
    return failedResult({
      tool: input.tool,
      operation: input.operation,
      startedAt,
      inputHash,
      checks,
      liveRequestAttempted: false,
      code: preflightFailure.code,
      message: preflightFailure.message,
      details: preflightFailure.details,
    });
  }

  if (input.operation === 'preflight') {
    return {
      tool_id: input.tool.id,
      tool_version_id: input.tool.tool_version_id,
      configuration_hash: input.tool.configuration_hash,
      operation: input.operation,
      status: 'passed',
      live_request_attempted: false,
      checked_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      input_hash: null,
      checks,
    };
  }

  const method = typeof input.tool.configuration.method === 'string'
    ? input.tool.configuration.method
    : null;
  const operationAllowed = input.operation === 'safe_test'
    ? input.tool.kind === 'http' && method === 'GET' && input.tool.risk_level === 'read'
    : input.tool.kind === 'mcp';
  if (!operationAllowed) {
    return failedResult({
      tool: input.tool,
      operation: input.operation,
      startedAt,
      inputHash,
      checks,
      liveRequestAttempted: false,
      code: 'diagnostic_operation_unsafe',
      message: input.operation === 'safe_test'
        ? 'Live tests are limited to read-risk HTTP GET tools.'
        : 'Discovery is available only for remote MCP tools.',
    });
  }

  const baseAudit = {
    operation: input.operation,
    inputHash,
  };
  try {
    await input.recordDiagnosticEvent?.({
      ...baseAudit,
      phase: 'started',
      liveRequestAttempted: false,
    });
  } catch {
    return failedResult({
      tool: input.tool,
      operation: input.operation,
      startedAt,
      inputHash,
      checks,
      liveRequestAttempted: false,
      code: 'diagnostic_audit_failed',
      message: 'The live diagnostic was not sent because its audit record could not be created.',
    });
  }

  let result: AgentToolDiagnosticResult;
  let liveRequestAttempted = false;
  // This callback runs immediately before fetch. It proves that every local
  // fail-closed boundary was crossed, but cannot prove that the peer received
  // any bytes, so the public/audit field deliberately says "attempted".
  const markRequestStarted = () => { liveRequestAttempted = true; };
  try {
    const configuredTimeout = Number(input.tool.configuration.timeout_ms);
    const timeoutMs = Number.isInteger(configuredTimeout)
      ? Math.max(1000, Math.min(configuredTimeout, 60000))
      : 20000;
    const deadlineSignal = AbortSignal.timeout(timeoutMs);
    const context = {
      // Discovery can issue multiple tools/list requests. The configured
      // timeout bounds the whole diagnostic, not each page independently.
      signal: input.signal
        ? AbortSignal.any([input.signal, deadlineSignal])
        : deadlineSignal,
      idempotencyKey: `agent-tool-diagnostic-${crypto.randomUUID()}`,
      attempt: 1,
      toolCallId: `diagnostic:${crypto.randomUUID()}`,
      runId: null,
      agentId: null,
    };
    if (input.operation === 'safe_test') {
      const response = await executeCustomHttpToolRequest({
        tool: input.tool,
        arguments: input.arguments || {},
        context,
        recordSecretEvent: input.recordSecretEvent,
        onRequestStart: markRequestStarted,
        redactResponseSecrets: true,
      });
      result = {
        tool_id: input.tool.id,
        tool_version_id: input.tool.tool_version_id,
        configuration_hash: input.tool.configuration_hash,
        operation: input.operation,
        status: 'passed',
        live_request_attempted: liveRequestAttempted,
        checked_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        input_hash: inputHash,
        checks,
        response: { status: response.status, preview: previewValue(response.data) },
      };
    } else {
      const discovery = await discoverCustomMcpTools({
        tool: input.tool,
        context,
        recordSecretEvent: input.recordSecretEvent,
        onRequestStart: markRequestStarted,
      });
      result = {
        tool_id: input.tool.id,
        tool_version_id: input.tool.tool_version_id,
        configuration_hash: input.tool.configuration_hash,
        operation: input.operation,
        status: discovery.selected_tool_found ? 'passed' : 'failed',
        live_request_attempted: liveRequestAttempted,
        checked_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        input_hash: null,
        checks,
        discovery,
        ...(!discovery.selected_tool_found ? {
          error: {
            code: 'mcp_selected_tool_missing',
            message: 'The configured MCP tool name was not returned by tools/list.',
          },
        } : {}),
      };
    }
  } catch (error) {
    const failure = diagnosticError(error);
    result = failedResult({
      tool: input.tool,
      operation: input.operation,
      startedAt,
      inputHash,
      checks,
      liveRequestAttempted,
      code: failure.code,
      message: failure.message,
      details: failure.details,
    });
  }

  try {
    await input.recordDiagnosticEvent?.({
      ...baseAudit,
      phase: 'completed',
      liveRequestAttempted,
      status: result.status,
      errorCode: result.error?.code,
      durationMs: result.duration_ms,
    });
  } catch {
    return failedResult({
      tool: input.tool,
      operation: input.operation,
      startedAt,
      inputHash,
      checks,
      liveRequestAttempted,
      code: 'diagnostic_audit_failed',
      message: 'The live diagnostic completed, but its outcome audit could not be recorded.',
    });
  }
  return result;
};

// Keep the public result code surface additive and make intentional reuse of
// runtime error codes visible to TypeScript.
export type AgentToolDiagnosticRuntimeErrorCode = AgentToolErrorCode;

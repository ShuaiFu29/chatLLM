/**
 * Every custom-tool failure used to collapse into one opaque string
 * ("Tool execution failed") before it reached the step log, the SSE stream, or
 * the model. That single label covered an allowlist rejection, a timeout, an
 * oversized body, malformed JSON, a missing response_path, and an MCP protocol
 * fault, so an operator could not tell a misconfiguration from a flaky upstream,
 * and the model could not tell "fix your arguments" from "retry later".
 *
 * Failures raised by the runtime therefore carry a stable machine code plus a
 * caller-safe summary. Codes are part of the step output contract: keep them
 * additive.
 */
export const agentToolErrorCodes = [
  'tool_input_invalid',
  'tool_endpoint_not_allowlisted',
  'tool_endpoint_unsupported_protocol',
  'tool_endpoint_credentials_insecure',
  'tool_endpoint_blocked_address',
  'tool_endpoint_misconfigured',
  'tool_timeout',
  'tool_network_error',
  'tool_http_status',
  'tool_response_too_large',
  'tool_response_invalid_json',
  'tool_response_path_missing',
  'tool_mcp_protocol_error',
  'tool_reported_error',
  'tool_execution_failed',
  // Dispatching work to another Agent. A failed subtask is reported to the parent
  // with its own reason so the parent can tell the user which part of the task
  // could not be completed, instead of failing the whole request.
  'subagent_unavailable',
  'subagent_depth_exceeded',
  'subagent_cycle_detected',
  'subagent_policy_violation',
  'subagent_budget_exhausted',
  'subagent_timeout',
  'subagent_failed',
  // A human declined, or nobody decided in time, on a tool a subagent needed.
  'subagent_approval_rejected',
  'subagent_approval_expired',
] as const;

export type AgentToolErrorCode = typeof agentToolErrorCodes[number];

export class AgentToolError extends Error {
  readonly code: AgentToolErrorCode;

  readonly details?: Record<string, unknown>;

  constructor(code: AgentToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AgentToolError';
    this.code = code;
    this.details = details;
  }
}

export const isAgentToolError = (value: unknown): value is AgentToolError => (
  value instanceof AgentToolError
);

/**
 * Failures that are worth another attempt: the request either never reached the
 * tool or produced no usable answer for transport reasons.
 *
 * Everything else is deliberately excluded. A misconfigured endpoint, an
 * un-allowlisted host, malformed arguments or a tool that reported its own error
 * will fail identically on a second attempt, so retrying only burns budget. An
 * HTTP status is excluded too: a 500 may well have applied a side effect before
 * failing, and the runtime cannot tell from the outside.
 */
const RETRYABLE_TOOL_ERROR_CODES = new Set<AgentToolErrorCode>([
  'tool_timeout',
  'tool_network_error',
]);

export const isRetryableAgentToolErrorCode = (code: AgentToolErrorCode) => (
  RETRYABLE_TOOL_ERROR_CODES.has(code)
);

// undici/Node surface transport faults as an opaque "fetch failed" TypeError and
// hide the real reason on `cause.code`. Reading it keeps a DNS failure from
// looking like a bug in the tool definition.
const networkErrorCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAMILY',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EPROTO',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_RESPONSE_STATUS_CODE',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const readErrorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object') return '';
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) return readErrorCode(cause);
  return '';
};

export interface ClassifiedAgentToolError {
  code: AgentToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Normalise anything thrown while executing a tool into a code plus a summary
 * that is safe to persist and to hand to the model. Run-level concerns
 * (cancellation, approval expiry, resource limits) are rethrown by the caller
 * before they reach here.
 */
export const classifyAgentToolError = (error: unknown): ClassifiedAgentToolError => {
  if (isAgentToolError(error)) {
    return { code: error.code, message: error.message, details: error.details };
  }
  const name = error instanceof Error ? error.name : '';
  // AbortSignal.timeout rejects with a TimeoutError; a per-tool AbortError means
  // the tool's own deadline fired, because run cancellation is filtered earlier.
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { code: 'tool_timeout', message: 'The tool did not respond before its timeout' };
  }
  if (name === 'SyntaxError') {
    return { code: 'tool_response_invalid_json', message: 'The tool returned a malformed JSON payload' };
  }
  const errorCode = readErrorCode(error);
  if (errorCode && networkErrorCodes.has(errorCode)) {
    return {
      code: 'tool_network_error',
      message: 'The tool endpoint could not be reached',
      details: { reason: errorCode },
    };
  }
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    return { code: 'tool_network_error', message: 'The tool endpoint could not be reached' };
  }
  return { code: 'tool_execution_failed', message: 'Tool execution failed' };
};

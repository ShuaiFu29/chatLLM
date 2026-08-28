/**
 * Correlation identity carried across the service boundary.
 *
 * Before this existed, an Agent Run's step log stopped at "called the agentic_rag
 * tool" and the RAG service kept an entirely separate trace of its own retrieval
 * decisions. Nothing linked the two, so answering "why did this Agent cite that
 * document" meant guessing which RAG run belonged to which tool call by
 * timestamp. The identifiers below close that gap in both directions: the trace
 * and span travel outbound in headers, and the RAG run id comes back in the
 * response and is recorded on the tool result step.
 */

export const TRACE_ID_HEADER = 'X-ChatLLM-Trace-Id';
export const SPAN_ID_HEADER = 'X-ChatLLM-Span-Id';

export interface TraceContext {
  /** The root Run of the tree this work belongs to. Stable across subagents. */
  traceId: string;
  /** The step that caused this work, so downstream records can parent to it. */
  spanId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only well-formed identifiers are forwarded. A trace header is attacker
 * influenced in the sense that it ends up in logs and database columns
 * downstream, so it is validated at the boundary rather than trusted.
 */
export const isTraceIdentifier = (value: unknown): value is string => (
  typeof value === 'string' && UUID_PATTERN.test(value)
);

export const buildTraceHeaders = (trace?: TraceContext | null): Record<string, string> => {
  if (!trace) return {};
  const headers: Record<string, string> = {};
  if (isTraceIdentifier(trace.traceId)) headers[TRACE_ID_HEADER] = trace.traceId;
  if (isTraceIdentifier(trace.spanId)) headers[SPAN_ID_HEADER] = trace.spanId;
  return headers;
};

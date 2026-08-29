import { createHash } from 'node:crypto';
import type { AgentRuntimeTool, AgentToolApprovalDescriptor } from './agent-tool';
import type { AgentApprovalPolicy } from './tool-policy';

export type AgentApprovalToolKind = AgentToolApprovalDescriptor['kind'];

/**
 * Immutable description of the exact operation a person was asked to approve.
 *
 * Field names deliberately match the JSON persisted in PostgreSQL and returned
 * to the client. Adding or changing a field requires a new format version: an
 * approval is an audit record, not mutable presentation metadata.
 */
export interface AgentApprovalIntent {
  format_version: 1;
  tool_key: string;
  tool_kind: AgentApprovalToolKind;
  tool_version_id: string | null;
  configuration_hash: string | null;
  secret_version: number | null;
  input_hash: string;
  target: string | null;
  method: string;
  risk_level: AgentRuntimeTool['riskLevel'];
  policy_chain: AgentApprovalPolicy[];
  side_effect_summary: string;
}

export interface AgentApprovalIntentBinding {
  intent: AgentApprovalIntent;
  intentHash: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

/** Stable JSON shared by input and intent fingerprints. */
export const canonicalizeAgentApprovalJson = (value: unknown): string => {
  const canonicalNumber = (number: number) => {
    if (!Number.isFinite(number)) {
      throw new Error('Agent approval JSON contains a non-finite number');
    }
    if (Object.is(number, -0)) return '0';
    const rendered = String(number);
    if (!/[eE]/.test(rendered)) return rendered;
    const [coefficient, rawExponent] = rendered.toLowerCase().split('e');
    const exponent = Number(rawExponent);
    const negative = coefficient.startsWith('-');
    const unsigned = negative ? coefficient.slice(1) : coefficient;
    const [integer, fraction = ''] = unsigned.split('.');
    const digits = `${integer}${fraction}`;
    const decimalPosition = integer.length + exponent;
    const magnitude = decimalPosition <= 0
      ? `0.${'0'.repeat(-decimalPosition)}${digits}`
      : decimalPosition >= digits.length
        ? `${digits}${'0'.repeat(decimalPosition - digits.length)}`
        : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
    return negative ? `-${magnitude}` : magnitude;
  };
  const serialize = (current: unknown): string => {
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number') return canonicalNumber(current);
    if (Array.isArray(current)) return `[${current.map(serialize).join(',')}]`;
    if (isRecord(current)) {
      return `{${Object.keys(current)
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map((key) => `${JSON.stringify(key)}:${serialize(current[key])}`)
        .join(',')}}`;
    }
    throw new Error('Agent approval JSON is not serializable');
  };
  return serialize(value);
};

export const hashAgentApprovalJson = (value: unknown) => createHash('sha256')
  .update(canonicalizeAgentApprovalJson(value), 'utf8')
  .digest('hex');

const defaultDescriptor = (tool: AgentRuntimeTool): AgentToolApprovalDescriptor => ({
  kind: 'builtin',
  method: 'invoke',
  target: null,
  sideEffectSummary: tool.riskLevel === 'read'
    ? `Read data using ${tool.key}.`
    : tool.riskLevel === 'write'
      ? `Invoke ${tool.key}; this operation may change durable state.`
      : `Invoke high-risk tool ${tool.key}; this operation may change external or durable state.`,
});

const cleanOptionalHash = (value: string | null | undefined) => {
  if (value === undefined || value === null || value === '') return null;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Agent approval configuration hash is invalid');
  }
  return value;
};

export const createAgentApprovalIntent = (input: {
  tool: AgentRuntimeTool;
  args: Record<string, unknown>;
  policyChain: ReadonlyArray<AgentApprovalPolicy>;
}): AgentApprovalIntentBinding => {
  if (input.policyChain.length === 0) {
    throw new Error('Agent approval policy chain is empty');
  }
  const descriptor = input.tool.describeApproval?.(input.args) || defaultDescriptor(input.tool);
  const method = descriptor.method.trim();
  const sideEffectSummary = descriptor.sideEffectSummary.trim();
  if (!method || method.length > 160) throw new Error('Agent approval method is invalid');
  if (!sideEffectSummary || sideEffectSummary.length > 1_000) {
    throw new Error('Agent approval side-effect summary is invalid');
  }
  const target = descriptor.target?.trim() || null;
  if (target && target.length > 2_000) throw new Error('Agent approval target is too long');
  const secretVersion = descriptor.secretVersion ?? null;
  if (secretVersion !== null && (!Number.isSafeInteger(secretVersion) || secretVersion <= 0)) {
    throw new Error('Agent approval secret version is invalid');
  }
  const intent: AgentApprovalIntent = {
    format_version: 1,
    tool_key: input.tool.key,
    tool_kind: descriptor.kind,
    tool_version_id: descriptor.toolVersionId || null,
    configuration_hash: cleanOptionalHash(descriptor.configurationHash),
    secret_version: secretVersion,
    input_hash: hashAgentApprovalJson(input.args),
    target,
    method,
    risk_level: input.tool.riskLevel,
    policy_chain: [...input.policyChain],
    side_effect_summary: sideEffectSummary,
  };
  return { intent, intentHash: hashAgentApprovalJson(intent) };
};

export class AgentApprovalIntentMismatchError extends Error {
  readonly code = 'AGENT_APPROVAL_INTENT_MISMATCH';

  constructor(message = 'The approved Agent tool intent no longer matches the operation') {
    super(message);
    this.name = 'AgentApprovalIntentMismatchError';
  }
}

/** Fail closed before an approved operation reaches its tool implementation. */
export const assertAgentApprovalIntentMatches = (input: {
  approvedIntent: AgentApprovalIntent;
  approvedIntentHash: string;
  tool: AgentRuntimeTool;
  args: Record<string, unknown>;
  policyChain: ReadonlyArray<AgentApprovalPolicy>;
}) => {
  const current = createAgentApprovalIntent(input);
  if (
    current.intentHash !== input.approvedIntentHash
    || hashAgentApprovalJson(input.approvedIntent) !== input.approvedIntentHash
  ) {
    throw new AgentApprovalIntentMismatchError();
  }
};

/** Display-safe HTTP target: credentials and query parameters never enter intent. */
export const createAgentApprovalHttpTarget = (
  endpoint: string,
  args: Record<string, unknown>,
) => {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(
    /(?:\{|%7B)([A-Za-z_][A-Za-z0-9_]*)(?:\}|%7D)/gi,
    (match, key: string) => {
      const value = args[key];
      return value === undefined || value === null ? match : encodeURIComponent(String(value));
    },
  );
  return `${url.origin}${url.pathname}`;
};

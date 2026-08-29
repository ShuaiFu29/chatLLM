import type { AgentEvalEvaluationSpec, AgentEvalExpectedToolCall } from './types';

export interface AgentEvalCaseOracleDraft {
  expectedOutput: string;
  forbiddenOutput: string;
  expectedToolCalls: string;
  forbiddenToolKeys: string;
  groundingEvidence: string;
  expectedCitations: string;
}

export const splitAgentEvalOracleLines = (value: string) => value
  .split('\n')
  .map((item) => item.trim())
  .filter(Boolean);

export const parseAgentEvalExpectedToolCalls = (value: string): AgentEvalExpectedToolCall[] => {
  if (!value.trim()) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 24) {
    throw new Error('Expected tool calls must be an array of at most 24 items');
  }
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Expected tool call must be an object');
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => !['tool_key', 'arguments', 'fixture'].includes(key))) {
      throw new Error('Expected tool call contains an unknown field');
    }
    if (typeof record.tool_key !== 'string' || !record.tool_key.trim() || record.tool_key.length > 160) {
      throw new Error('Expected tool call needs a bounded tool_key');
    }
    if (
      record.arguments !== undefined
      && (!record.arguments || typeof record.arguments !== 'object' || Array.isArray(record.arguments))
    ) {
      throw new Error('Expected tool call arguments must be an object');
    }
    return {
      tool_key: record.tool_key.trim(),
      ...(record.arguments === undefined
        ? {}
        : { arguments: record.arguments as Record<string, unknown> }),
      ...(Object.hasOwn(record, 'fixture') ? { fixture: record.fixture } : {}),
    };
  });
};

export const buildAgentEvalEvaluationSpec = (
  draft: AgentEvalCaseOracleDraft,
): AgentEvalEvaluationSpec | null => {
  const spec: AgentEvalEvaluationSpec = {};
  const expectedOutput = splitAgentEvalOracleLines(draft.expectedOutput);
  const forbiddenOutput = splitAgentEvalOracleLines(draft.forbiddenOutput);
  const expectedToolCalls = parseAgentEvalExpectedToolCalls(draft.expectedToolCalls);
  const forbiddenToolKeys = splitAgentEvalOracleLines(draft.forbiddenToolKeys);
  const groundingEvidence = splitAgentEvalOracleLines(draft.groundingEvidence);
  const expectedCitations = splitAgentEvalOracleLines(draft.expectedCitations);
  if (expectedOutput.length > 0) spec.expected_output_contains = expectedOutput;
  if (forbiddenOutput.length > 0) spec.forbidden_output_contains = forbiddenOutput;
  if (expectedToolCalls.length > 0) spec.expected_tool_calls = expectedToolCalls;
  if (forbiddenToolKeys.length > 0) spec.forbidden_tool_keys = forbiddenToolKeys;
  if (groundingEvidence.length > 0) spec.grounding_evidence = groundingEvidence;
  if (expectedCitations.length > 0) spec.expected_citations = expectedCitations;
  return Object.keys(spec).length > 0 ? spec : null;
};

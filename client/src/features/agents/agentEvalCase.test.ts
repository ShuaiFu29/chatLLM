import { describe, expect, test } from 'vitest';
import {
  buildAgentEvalEvaluationSpec,
  parseAgentEvalExpectedToolCalls,
} from './agentEvalCase';

describe('Agent version evaluation case builder', () => {
  test('normalizes line-based Gold labels and structured fixture calls', () => {
    expect(buildAgentEvalEvaluationSpec({
      expectedOutput: 'ready\nrelease v2',
      forbiddenOutput: 'deleted',
      expectedToolCalls: JSON.stringify([{
        tool_key: 'lookup_release',
        arguments: { release: 'v2' },
        fixture: { ready: true },
      }]),
      forbiddenToolKeys: 'delete_release',
      groundingEvidence: 'Release v2 is ready.',
      expectedCitations: '[release-note]',
    })).toEqual({
      expected_output_contains: ['ready', 'release v2'],
      forbidden_output_contains: ['deleted'],
      expected_tool_calls: [{
        tool_key: 'lookup_release',
        arguments: { release: 'v2' },
        fixture: { ready: true },
      }],
      forbidden_tool_keys: ['delete_release'],
      grounding_evidence: ['Release v2 is ready.'],
      expected_citations: ['[release-note]'],
    });
  });

  test('requires an oracle and rejects malformed tool fixtures before transport', () => {
    expect(buildAgentEvalEvaluationSpec({
      expectedOutput: '',
      forbiddenOutput: '',
      expectedToolCalls: '',
      forbiddenToolKeys: '',
      groundingEvidence: '',
      expectedCitations: '',
    })).toBeNull();
    expect(() => parseAgentEvalExpectedToolCalls('{"tool_key":"lookup"}')).toThrow(/array/);
    expect(() => parseAgentEvalExpectedToolCalls('[{"tool_key":"lookup","arguments":[]}]')).toThrow(/object/);
    expect(() => parseAgentEvalExpectedToolCalls('[{"tool_key":"lookup","secret":"x"}]')).toThrow(/unknown/);
  });
});

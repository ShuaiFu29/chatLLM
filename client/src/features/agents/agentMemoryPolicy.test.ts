import { describe, expect, test } from 'vitest';
import {
  clampAgentSummaryTokens,
  memoryPolicyFromPreset,
  modeForMemoryPolicy,
  setConversationHistoryEnabled,
  setRollingSummaryEnabled,
} from './agentMemoryPolicy';

describe('Agent Memory Policy presets', () => {
  test.each(['none', 'conversation', 'user', 'project'] as const)(
    'projects %s back to its compatibility mode',
    (mode) => {
      expect(modeForMemoryPolicy(memoryPolicyFromPreset(mode))).toBe(mode);
    },
  );

  test('compares JSONB-shaped policies independently of object key order', () => {
    const policy = memoryPolicyFromPreset('user');
    // Rebuild at every nested level, as PostgreSQL jsonb may return a different
    // insertion order from the browser-created preset.
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => right.localeCompare(left))
          .map(([key, item]) => [key, reorder(item)]),
      );
    };
    expect(modeForMemoryPolicy(reorder(policy) as typeof policy)).toBe('user');
  });

  test('marks semantic edits as custom', () => {
    const policy = memoryPolicyFromPreset('conversation');
    policy.read.top_k = 7;
    expect(modeForMemoryPolicy(policy)).toBe('custom');
  });

  test('enables rolling summaries with a deterministic default budget', () => {
    const policy = memoryPolicyFromPreset('conversation');
    expect(setRollingSummaryEnabled(policy, true).conversation.rolling_summary).toEqual({
      enabled: true,
      max_tokens: 512,
    });
  });

  test('disabling conversation history also disables its rolling summary', () => {
    const policy = setRollingSummaryEnabled(memoryPolicyFromPreset('conversation'), true);
    expect(setConversationHistoryEnabled(policy, false).conversation).toEqual({
      enabled: false,
      message_limit: 0,
      rolling_summary: { enabled: false, max_tokens: 0 },
    });
  });

  test('clamps rolling-summary token budgets to the supported range', () => {
    expect(clampAgentSummaryTokens(1)).toBe(32);
    expect(clampAgentSummaryTokens(128.9)).toBe(128);
    expect(clampAgentSummaryTokens(9_999)).toBe(4_000);
    expect(clampAgentSummaryTokens(Number.NaN)).toBe(512);
  });
});

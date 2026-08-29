import type {
  AgentMemoryMode,
  AgentMemoryPolicy,
  AgentMemoryScope,
} from './types';

const allScopes: AgentMemoryScope[] = ['user', 'project', 'agent'];

export const DEFAULT_AGENT_SUMMARY_TOKENS = 512;
export const MIN_AGENT_SUMMARY_TOKENS = 32;
export const MAX_AGENT_SUMMARY_TOKENS = 4_000;

export const clampAgentSummaryTokens = (value: number) => {
  const finiteValue = Number.isFinite(value) ? Math.floor(value) : DEFAULT_AGENT_SUMMARY_TOKENS;
  return Math.min(MAX_AGENT_SUMMARY_TOKENS, Math.max(MIN_AGENT_SUMMARY_TOKENS, finiteValue));
};

export const setConversationHistoryEnabled = (
  policy: AgentMemoryPolicy,
  enabled: boolean,
): AgentMemoryPolicy => ({
  ...policy,
  conversation: {
    ...policy.conversation,
    enabled,
    message_limit: enabled ? Math.max(1, policy.conversation.message_limit || 20) : 0,
    rolling_summary: enabled
      ? policy.conversation.rolling_summary
      : { enabled: false, max_tokens: 0 },
  },
});

export const setRollingSummaryEnabled = (
  policy: AgentMemoryPolicy,
  enabled: boolean,
): AgentMemoryPolicy => ({
  ...policy,
  conversation: {
    ...policy.conversation,
    rolling_summary: enabled
      ? {
          enabled: true,
          max_tokens: clampAgentSummaryTokens(
            policy.conversation.rolling_summary.max_tokens || DEFAULT_AGENT_SUMMARY_TOKENS,
          ),
        }
      : { enabled: false, max_tokens: 0 },
  },
});

export const memoryPolicyFromPreset = (
  mode: Exclude<AgentMemoryMode, 'custom'>,
): AgentMemoryPolicy => {
  const conversationEnabled = mode !== 'none';
  const autoScopes: AgentMemoryScope[] = mode === 'user'
    ? ['user', 'agent']
    : mode === 'project'
      ? ['project', 'agent']
      : [];
  return {
    format_version: 1,
    conversation: {
      enabled: conversationEnabled,
      message_limit: conversationEnabled ? 20 : 0,
      rolling_summary: { enabled: false, max_tokens: 0 },
    },
    persona: { enabled: mode === 'user' },
    project_context: { enabled: mode === 'project' },
    read: {
      allowed_scopes: [...allScopes],
      auto_recall: autoScopes.length > 0,
      auto_scopes: autoScopes,
      top_k: 20,
      token_budget: 1_000,
      min_trust: 'tool_derived',
    },
    write: {
      enabled: true,
      allowed_scopes: [...allScopes],
      default_ttl_days: null,
      require_confirmation: true,
    },
    subagent: {
      share_recalled_memory: false,
      max_items: 0,
      token_budget: 0,
    },
  };
};

const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
};

export const modeForMemoryPolicy = (policy: AgentMemoryPolicy): AgentMemoryMode => {
  for (const mode of ['none', 'conversation', 'user', 'project'] as const) {
    if (JSON.stringify(canonicalJson(policy))
      === JSON.stringify(canonicalJson(memoryPolicyFromPreset(mode)))) return mode;
  }
  return 'custom';
};

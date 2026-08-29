import { z } from 'zod';

export const AGENT_MEMORY_POLICY_FORMAT_VERSION = 1 as const;

export type AgentMemoryMode = 'none' | 'conversation' | 'user' | 'project' | 'custom';
export type AgentMemoryScope = 'user' | 'project' | 'agent';
export type AgentMemorySourceTrust = 'user_stated' | 'agent_inferred' | 'tool_derived';

const memoryScopeSchema = z.enum(['user', 'project', 'agent']);
const memoryTrustSchema = z.enum(['user_stated', 'agent_inferred', 'tool_derived']);

const uniqueScopes = (scopes: AgentMemoryScope[]) => (
  new Set(scopes).size === scopes.length
);

export const agentMemoryPolicySchema = z.object({
  format_version: z.literal(AGENT_MEMORY_POLICY_FORMAT_VERSION),
  conversation: z.object({
    enabled: z.boolean(),
    message_limit: z.number().int().min(0).max(100),
    rolling_summary: z.object({
      enabled: z.boolean(),
      max_tokens: z.number().int().min(0).max(4_000),
    }).strict(),
  }).strict(),
  persona: z.object({
    enabled: z.boolean(),
  }).strict(),
  project_context: z.object({
    enabled: z.boolean(),
  }).strict(),
  read: z.object({
    allowed_scopes: z.array(memoryScopeSchema).max(3),
    auto_recall: z.boolean(),
    auto_scopes: z.array(memoryScopeSchema).max(3),
    top_k: z.number().int().min(1).max(20),
    token_budget: z.number().int().min(0).max(1_000),
    min_trust: memoryTrustSchema,
  }).strict(),
  write: z.object({
    enabled: z.boolean(),
    allowed_scopes: z.array(memoryScopeSchema).max(3),
    default_ttl_days: z.number().int().min(1).max(365).nullable(),
    require_confirmation: z.boolean(),
  }).strict(),
  subagent: z.object({
    share_recalled_memory: z.boolean(),
    max_items: z.number().int().min(0).max(20),
    token_budget: z.number().int().min(0).max(1_000),
  }).strict(),
}).strict().superRefine((policy, context) => {
  if (!uniqueScopes(policy.read.allowed_scopes)) {
    context.addIssue({ code: 'custom', path: ['read', 'allowed_scopes'], message: 'Memory scopes must be unique' });
  }
  if (!uniqueScopes(policy.read.auto_scopes)) {
    context.addIssue({ code: 'custom', path: ['read', 'auto_scopes'], message: 'Automatic memory scopes must be unique' });
  }
  if (!uniqueScopes(policy.write.allowed_scopes)) {
    context.addIssue({ code: 'custom', path: ['write', 'allowed_scopes'], message: 'Memory write scopes must be unique' });
  }
  const allowedReadScopes = new Set(policy.read.allowed_scopes);
  if (policy.read.auto_scopes.some((scope) => !allowedReadScopes.has(scope))) {
    context.addIssue({ code: 'custom', path: ['read', 'auto_scopes'], message: 'Automatic scopes must also be allowed read scopes' });
  }
  if (!policy.read.auto_recall && policy.read.auto_scopes.length > 0) {
    context.addIssue({ code: 'custom', path: ['read', 'auto_scopes'], message: 'Automatic scopes must be empty when automatic recall is disabled' });
  }
  if (policy.read.auto_recall && policy.read.auto_scopes.length === 0) {
    context.addIssue({ code: 'custom', path: ['read', 'auto_scopes'], message: 'Automatic recall requires at least one scope' });
  }
  if (policy.read.auto_recall && policy.read.token_budget === 0) {
    context.addIssue({ code: 'custom', path: ['read', 'token_budget'], message: 'Automatic recall requires a positive token budget' });
  }
  if (!policy.conversation.enabled && policy.conversation.message_limit !== 0) {
    context.addIssue({ code: 'custom', path: ['conversation', 'message_limit'], message: 'Conversation history limit must be zero when disabled' });
  }
  if (policy.conversation.enabled && policy.conversation.message_limit === 0) {
    context.addIssue({ code: 'custom', path: ['conversation', 'message_limit'], message: 'Enabled conversation history requires a positive limit' });
  }
  if (!policy.conversation.rolling_summary.enabled
    && policy.conversation.rolling_summary.max_tokens !== 0) {
    context.addIssue({ code: 'custom', path: ['conversation', 'rolling_summary', 'max_tokens'], message: 'Rolling-summary tokens must be zero when disabled' });
  }
  if (policy.conversation.rolling_summary.enabled
    && policy.conversation.rolling_summary.max_tokens < 32) {
    context.addIssue({ code: 'custom', path: ['conversation', 'rolling_summary', 'max_tokens'], message: 'Enabled rolling summaries require at least 32 tokens' });
  }
  if (!policy.write.enabled && policy.write.allowed_scopes.length > 0) {
    context.addIssue({ code: 'custom', path: ['write', 'allowed_scopes'], message: 'Memory write scopes must be empty when writes are disabled' });
  }
  if (policy.write.enabled && policy.write.allowed_scopes.length === 0) {
    context.addIssue({ code: 'custom', path: ['write', 'allowed_scopes'], message: 'Enabled memory writes require at least one scope' });
  }
  if (policy.subagent.share_recalled_memory
    && (policy.subagent.max_items === 0 || policy.subagent.token_budget === 0)) {
    context.addIssue({ code: 'custom', path: ['subagent'], message: 'Subagent memory sharing requires positive item and token budgets' });
  }
  if (!policy.subagent.share_recalled_memory
    && (policy.subagent.max_items !== 0 || policy.subagent.token_budget !== 0)) {
    context.addIssue({ code: 'custom', path: ['subagent'], message: 'Subagent memory budgets must be zero when sharing is disabled' });
  }
});

export type AgentMemoryPolicy = z.infer<typeof agentMemoryPolicySchema>;

const durableReadDefaults = {
  allowed_scopes: ['user', 'project', 'agent'] as AgentMemoryScope[],
  top_k: 20,
  token_budget: 1_000,
  min_trust: 'tool_derived' as const,
};

const commonPolicy = {
  format_version: AGENT_MEMORY_POLICY_FORMAT_VERSION,
  persona: { enabled: false },
  project_context: { enabled: false },
  write: {
    enabled: true,
    allowed_scopes: ['user', 'project', 'agent'] as AgentMemoryScope[],
    default_ttl_days: null,
    require_confirmation: true,
  },
  subagent: {
    share_recalled_memory: false,
    max_items: 0,
    token_budget: 0,
  },
};

/** Preserve every legacy mode's behaviour while giving it an explicit policy. */
export const memoryPolicyFromLegacyMode = (
  mode: Exclude<AgentMemoryMode, 'custom'>,
): AgentMemoryPolicy => {
  const conversationEnabled = mode !== 'none';
  const autoScopes: AgentMemoryScope[] = mode === 'user'
    ? ['user', 'agent']
    : mode === 'project'
      ? ['project', 'agent']
      : [];
  return agentMemoryPolicySchema.parse({
    ...commonPolicy,
    conversation: {
      enabled: conversationEnabled,
      message_limit: conversationEnabled ? 20 : 0,
      rolling_summary: { enabled: false, max_tokens: 0 },
    },
    persona: { enabled: mode === 'user' },
    project_context: { enabled: mode === 'project' },
    read: {
      ...durableReadDefaults,
      auto_recall: autoScopes.length > 0,
      auto_scopes: autoScopes,
    },
  });
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

const samePolicy = (left: AgentMemoryPolicy, right: AgentMemoryPolicy) => (
  JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
);

/** `memory_mode` is now a compatibility projection, not an execution source. */
export const memoryModeFromPolicy = (policy: AgentMemoryPolicy): AgentMemoryMode => {
  for (const mode of ['none', 'conversation', 'user', 'project'] as const) {
    if (samePolicy(policy, memoryPolicyFromLegacyMode(mode))) return mode;
  }
  return 'custom';
};

export const parseAgentMemoryPolicy = (value: unknown) => agentMemoryPolicySchema.parse(value);

export const resolveAgentMemoryPolicy = (
  policy: unknown,
  legacyMode: AgentMemoryMode = 'conversation',
): AgentMemoryPolicy => {
  if (policy !== undefined && policy !== null) return parseAgentMemoryPolicy(policy);
  if (legacyMode === 'custom') throw new Error('Custom memory mode requires a structured policy');
  return memoryPolicyFromLegacyMode(legacyMode);
};

export const tokenBudgetToCharacterBudget = (tokenBudget: number) => (
  Math.max(0, Math.min(4_000, Math.floor(tokenBudget) * 4))
);

export interface AgentSharedMemoryItem {
  id: string;
  line: string;
}

export interface AgentSharedMemorySnapshot {
  format_version: 1;
  items: readonly AgentSharedMemoryItem[];
  character_count: number;
}

export const agentSharedMemorySnapshotSchema = z.object({
  format_version: z.literal(1),
  items: z.array(z.object({
    id: z.string().uuid(),
    line: z.string().min(1).max(2_500),
  }).strict()).max(20),
  character_count: z.number().int().min(0).max(4_000),
}).strict().superRefine((snapshot, context) => {
  if (new Set(snapshot.items.map((item) => item.id)).size !== snapshot.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'Shared memory ids must be unique' });
  }
  if (snapshot.items.reduce((sum, item) => sum + item.line.length, 0)
    !== snapshot.character_count) {
    context.addIssue({ code: 'custom', path: ['character_count'], message: 'Shared memory character count is inconsistent' });
  }
});

export const parseAgentSharedMemorySnapshot = (value: unknown): AgentSharedMemorySnapshot => (
  agentSharedMemorySnapshotSchema.parse(value)
);

/** Apply the receiving Agent's limits without ever widening the parent snapshot. */
export const limitAgentSharedMemorySnapshot = (
  policy: AgentMemoryPolicy,
  snapshot: AgentSharedMemorySnapshot,
): AgentSharedMemorySnapshot => {
  if (!policy.subagent.share_recalled_memory) {
    return { format_version: 1, items: [], character_count: 0 };
  }
  const characterLimit = tokenBudgetToCharacterBudget(policy.subagent.token_budget);
  const items: AgentSharedMemoryItem[] = [];
  let characterCount = 0;
  for (const item of snapshot.items.slice(0, policy.subagent.max_items)) {
    if (characterCount + item.line.length > characterLimit) break;
    items.push(structuredClone(item));
    characterCount += item.line.length;
  }
  return { format_version: 1, items, character_count: characterCount };
};

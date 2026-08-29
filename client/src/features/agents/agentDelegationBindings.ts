import type {
  Agent,
  AgentDelegationBinding,
  AgentToolBinding,
} from './types';

export const DISPATCH_SUBAGENTS_TOOL_KEY = 'dispatch_subagents';
export const MAX_AGENT_DELEGATION_BINDINGS = 16;
const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const CONTEXT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export type AgentDelegationBindingIssue =
  | 'invalid_alias'
  | 'duplicate_alias'
  | 'missing_role'
  | 'invalid_parallelism'
  | 'invalid_context_key'
  | 'duplicate_context_key'
  | 'too_many_bindings';

export const isAvailableAgentCollaborator = (
  candidate: Agent,
  sourceAgentId: string | null | undefined,
  sourceProjectSpaceId: string | null | undefined,
) => (
  candidate.id !== sourceAgentId
  && candidate.status === 'published'
  && Boolean(candidate.published_version_id)
  && (
    candidate.project_space_id == null
    || candidate.project_space_id === (sourceProjectSpaceId || null)
  )
);

const aliasBase = (name: string) => {
  const normalized = name
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  if (/^[a-z]/.test(normalized)) return normalized;
  return 'collaborator';
};

export const createUniqueAgentDelegationAlias = (
  name: string,
  bindings: readonly AgentDelegationBinding[],
) => {
  const used = new Set(bindings.map((binding) => binding.alias));
  const base = aliasBase(name);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${base.slice(0, 32 - suffixText.length)}${suffixText}`;
    if (!used.has(candidate)) return candidate;
  }
  return `collaborator_${bindings.length + 1}`.slice(0, 32);
};

export const createAgentDelegationBinding = (
  candidate: Agent,
  bindings: readonly AgentDelegationBinding[],
  role: string,
): AgentDelegationBinding | null => {
  if (!candidate.published_version_id) return null;
  return {
    alias: createUniqueAgentDelegationAlias(candidate.name, bindings),
    agent_id: candidate.id,
    version_policy: 'pinned',
    agent_version_id: candidate.published_version_id,
    role: role.trim().slice(0, 500) || candidate.name.slice(0, 500),
    max_parallelism: 1,
    allowed_context_keys: [],
  };
};

export const parseAgentDelegationContextKeys = (value: string) => value
  .split(/[\s,]+/)
  .map((key) => key.trim())
  .filter(Boolean);

export const findAgentDelegationBindingIssue = (
  bindings: readonly AgentDelegationBinding[],
): AgentDelegationBindingIssue | null => {
  if (bindings.length > MAX_AGENT_DELEGATION_BINDINGS) return 'too_many_bindings';
  const aliases = new Set<string>();
  for (const binding of bindings) {
    if (!ALIAS_PATTERN.test(binding.alias)) return 'invalid_alias';
    if (aliases.has(binding.alias)) return 'duplicate_alias';
    aliases.add(binding.alias);
    if (!binding.role.trim() || binding.role.length > 500) return 'missing_role';
    if (!Number.isInteger(binding.max_parallelism)
      || binding.max_parallelism < 1
      || binding.max_parallelism > 16) return 'invalid_parallelism';
    const contextKeys = new Set<string>();
    for (const key of binding.allowed_context_keys) {
      if (!CONTEXT_KEY_PATTERN.test(key)) return 'invalid_context_key';
      if (contextKeys.has(key)) return 'duplicate_context_key';
      contextKeys.add(key);
    }
  }
  return null;
};

export const syncDelegationToolBinding = (
  toolBindings: readonly AgentToolBinding[],
  delegationBindings: readonly AgentDelegationBinding[],
): AgentToolBinding[] => {
  const withoutDispatch = toolBindings.filter(
    (binding) => binding.key !== DISPATCH_SUBAGENTS_TOOL_KEY,
  );
  if (delegationBindings.length === 0) return withoutDispatch;
  return [
    ...withoutDispatch,
    { key: DISPATCH_SUBAGENTS_TOOL_KEY, enabled: true },
  ];
};

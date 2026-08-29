import type { AgentToolBinding } from './types';

export const toggleAgentToolBinding = (
  bindings: AgentToolBinding[],
  key: string,
  currentToolVersionId?: string,
): AgentToolBinding[] => {
  const isEnabled = bindings.some(
    (binding) => binding.key === key && binding.enabled !== false,
  );
  const withoutKey = bindings.filter((binding) => binding.key !== key);
  if (isEnabled) return withoutKey;
  return [
    ...withoutKey,
    {
      key,
      enabled: true,
      ...(currentToolVersionId ? { tool_version_id: currentToolVersionId } : {}),
    },
  ];
};

export const pinAgentToolBindingVersion = (
  bindings: AgentToolBinding[],
  key: string,
  toolVersionId: string,
): AgentToolBinding[] => bindings.map((binding) => (
  binding.key === key ? { ...binding, tool_version_id: toolVersionId } : binding
));

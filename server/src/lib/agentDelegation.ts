import { z } from 'zod';

export const AGENT_DELEGATION_BINDING_LIMIT = 16;
export const AGENT_DELEGATION_CONTEXT_KEY_LIMIT = 16;
export const AGENT_DELEGATION_ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const AGENT_DELEGATION_CONTEXT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export type AgentDelegationMode = 'explicit' | 'legacy_dynamic';

export interface AgentDelegationBinding {
  alias: string;
  agent_id: string;
  version_policy: 'pinned';
  agent_version_id: string;
  role: string;
  max_parallelism: number;
  allowed_context_keys: string[];
}

export const agentDelegationBindingSchema = z.object({
  alias: z.string().regex(AGENT_DELEGATION_ALIAS_PATTERN),
  agent_id: z.string().uuid(),
  version_policy: z.literal('pinned'),
  agent_version_id: z.string().uuid(),
  role: z.string().trim().min(1).max(500),
  max_parallelism: z.number().int().min(1).max(16),
  allowed_context_keys: z.array(
    z.string().regex(AGENT_DELEGATION_CONTEXT_KEY_PATTERN),
  ).max(AGENT_DELEGATION_CONTEXT_KEY_LIMIT),
}).strict();

export const agentDelegationBindingsSchema = z.array(agentDelegationBindingSchema)
  .max(AGENT_DELEGATION_BINDING_LIMIT)
  .superRefine((bindings, context) => {
    const aliases = new Set<string>();
    bindings.forEach((binding, bindingIndex) => {
      if (aliases.has(binding.alias)) {
        context.addIssue({
          code: 'custom',
          path: [bindingIndex, 'alias'],
          message: 'Delegation aliases must be unique',
        });
      }
      aliases.add(binding.alias);
      const contextKeys = new Set<string>();
      binding.allowed_context_keys.forEach((key, keyIndex) => {
        if (contextKeys.has(key)) {
          context.addIssue({
            code: 'custom',
            path: [bindingIndex, 'allowed_context_keys', keyIndex],
            message: 'Delegation context keys must be unique',
          });
        }
        contextKeys.add(key);
      });
    });
  });

export const parseAgentDelegationBindings = (value: unknown): AgentDelegationBinding[] => (
  agentDelegationBindingsSchema.parse(value).map((binding) => ({
    ...binding,
    allowed_context_keys: [...binding.allowed_context_keys],
  }))
);

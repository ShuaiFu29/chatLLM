import { describe, expect, test } from 'vitest';
import { memoryPolicyFromPreset } from './agentMemoryPolicy';
import {
  createAgentDelegationBinding,
  createUniqueAgentDelegationAlias,
  findAgentDelegationBindingIssue,
  isAvailableAgentCollaborator,
  parseAgentDelegationContextKeys,
  syncDelegationToolBinding,
} from './agentDelegationBindings';
import type { Agent, AgentDelegationBinding } from './types';

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'user-1',
  project_space_id: null,
  name: 'Technical Reviewer',
  description: '',
  avatar: '',
  visibility: 'private',
  status: 'published',
  current_version_id: '22222222-2222-4222-8222-222222222222',
  published_version_id: '33333333-3333-4333-8333-333333333333',
  latest_version: 2,
  version: 2,
  configuration_hash: 'a'.repeat(64),
  change_kind: 'edited',
  published_version: 1,
  has_unpublished_changes: true,
  instructions: 'Review',
  model: 'qwen-plus',
  temperature: 0.2,
  max_iterations: 4,
  max_duration_ms: 120000,
  max_output_tokens: 2048,
  memory_mode: 'conversation',
  memory_policy: memoryPolicyFromPreset('conversation'),
  response_format: 'markdown',
  output_schema: {},
  approval_policy: 'writes',
  tool_bindings: [],
  delegation_mode: 'explicit',
  delegation_bindings: [],
  welcome_message: '',
  suggested_prompts: [],
  created_at: '',
  updated_at: '',
  ...overrides,
});

describe('explicit Agent delegation bindings', () => {
  test('only published in-scope Agents can be selected as collaborators', () => {
    expect(isAvailableAgentCollaborator(agent(), null, null)).toBe(true);
    expect(isAvailableAgentCollaborator(agent(), agent().id, null)).toBe(false);
    expect(isAvailableAgentCollaborator(agent({ status: 'disabled' }), null, null)).toBe(false);
    expect(isAvailableAgentCollaborator(agent({ published_version_id: null }), null, null)).toBe(false);
    expect(isAvailableAgentCollaborator(agent({ project_space_id: 'space-a' }), null, 'space-b')).toBe(false);
    expect(isAvailableAgentCollaborator(agent({ project_space_id: 'space-a' }), null, 'space-a')).toBe(true);
  });

  test('new aliases are stable, unique, and pin the live version rather than the current draft', () => {
    const existing = [{ alias: 'technical_reviewer' }] as AgentDelegationBinding[];
    expect(createUniqueAgentDelegationAlias('Technical Reviewer', existing)).toBe('technical_reviewer_2');
    const binding = createAgentDelegationBinding(agent(), existing, 'Review technical risks');
    expect(binding).toMatchObject({
      alias: 'technical_reviewer_2',
      agent_version_id: '33333333-3333-4333-8333-333333333333',
      version_policy: 'pinned',
      role: 'Review technical risks',
    });
  });

  test('dispatch capability follows the collaborator directory exactly', () => {
    const binding = createAgentDelegationBinding(agent(), [], 'Review')!;
    expect(syncDelegationToolBinding([{ key: 'calculator', enabled: true }], [binding])).toEqual([
      { key: 'calculator', enabled: true },
      { key: 'dispatch_subagents', enabled: true },
    ]);
    expect(syncDelegationToolBinding([
      { key: 'calculator', enabled: true },
      { key: 'dispatch_subagents', enabled: true },
    ], [])).toEqual([{ key: 'calculator', enabled: true }]);
  });

  test('aliases, context keys, and parallelism are validated before save', () => {
    const binding = createAgentDelegationBinding(agent(), [], 'Review')!;
    expect(parseAgentDelegationContextKeys('requirements, constraints\nrelease.plan')).toEqual([
      'requirements',
      'constraints',
      'release.plan',
    ]);
    expect(findAgentDelegationBindingIssue([binding])).toBeNull();
    expect(findAgentDelegationBindingIssue([{ ...binding, alias: 'Raw UUID' }])).toBe('invalid_alias');
    expect(findAgentDelegationBindingIssue([binding, { ...binding }])).toBe('duplicate_alias');
    expect(findAgentDelegationBindingIssue([{
      ...binding,
      allowed_context_keys: ['requirements', 'requirements'],
    }])).toBe('duplicate_context_key');
    expect(findAgentDelegationBindingIssue([{ ...binding, max_parallelism: 0 }])).toBe('invalid_parallelism');
  });
});

import { describe, expect, test } from 'vitest';
import {
  pinAgentToolBindingVersion,
  toggleAgentToolBinding,
} from './agentToolBindings';

describe('versioned Agent tool bindings', () => {
  test('a new custom binding pins the tool version that is current in the catalog', () => {
    expect(toggleAgentToolBinding(
      [],
      'custom:11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    )).toEqual([{
      key: 'custom:11111111-1111-4111-8111-111111111111',
      enabled: true,
      tool_version_id: '22222222-2222-4222-8222-222222222222',
    }]);
  });

  test('re-enabling a disabled legacy binding replaces it instead of creating a duplicate', () => {
    expect(toggleAgentToolBinding(
      [{
        key: 'custom:11111111-1111-4111-8111-111111111111',
        enabled: false,
      }],
      'custom:11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
    )).toEqual([{
      key: 'custom:11111111-1111-4111-8111-111111111111',
      enabled: true,
      tool_version_id: '33333333-3333-4333-8333-333333333333',
    }]);
  });

  test('an explicit upgrade changes only the selected binding version', () => {
    const bindings = [
      {
        key: 'custom:11111111-1111-4111-8111-111111111111',
        enabled: true,
        tool_version_id: '22222222-2222-4222-8222-222222222222',
      },
      { key: 'calculator', enabled: true },
    ];
    expect(pinAgentToolBindingVersion(
      bindings,
      bindings[0].key,
      '33333333-3333-4333-8333-333333333333',
    )).toEqual([
      {
        ...bindings[0],
        tool_version_id: '33333333-3333-4333-8333-333333333333',
      },
      bindings[1],
    ]);
    expect(bindings[0].tool_version_id).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
  });
});

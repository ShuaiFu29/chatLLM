import { describe, expect, test } from 'vitest';
import { buildAgentToolSecrets } from './agentToolSecrets';

describe('Agent tool Secret field drafts', () => {
  test('omits untouched blank rows', () => {
    expect(buildAgentToolSecrets([{ id: '1', key: '', value: '' }])).toBeUndefined();
  });

  test('preserves each value while normalizing only the destination key', () => {
    expect(buildAgentToolSecrets([
      { id: '1', key: ' bearer_token ', value: ' token with spaces ' },
      { id: '2', key: 'header:X-Api-Key', value: 'secret' },
    ])).toEqual({
      bearer_token: ' token with spaces ',
      'header:X-Api-Key': 'secret',
    });
  });

  test('rejects partial and duplicate rows before an API request', () => {
    expect(() => buildAgentToolSecrets([{ id: '1', key: 'bearer_token', value: '' }]))
      .toThrow('incomplete_secret');
    expect(() => buildAgentToolSecrets([
      { id: '1', key: 'bearer_token', value: 'one' },
      { id: '2', key: ' bearer_token ', value: 'two' },
    ])).toThrow('duplicate_secret');
  });
});


import { describe, expect, it } from 'vitest';
import { requireInternalPath } from './navigation';

describe('requireInternalPath', () => {
  it('accepts origin-relative application paths', () => {
    expect(requireInternalPath('/knowledge?source=chat#preview')).toBe('/knowledge?source=chat#preview');
  });

  it.each(['https://example.com', '//example.com', 'knowledge'])('rejects external or relative target %s', (target) => {
    expect(() => requireInternalPath(target)).toThrow(/origin-relative/);
  });
});

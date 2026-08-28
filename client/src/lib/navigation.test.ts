import { describe, expect, it } from 'vitest';
import { normalizeRoutePath, requireInternalPath } from './navigation';

describe('requireInternalPath', () => {
  it('accepts origin-relative application paths', () => {
    expect(requireInternalPath('/knowledge?source=chat#preview')).toBe('/knowledge?source=chat#preview');
  });

  it.each(['https://example.com', '//example.com', 'knowledge'])('rejects external or relative target %s', (target) => {
    expect(() => requireInternalPath(target)).toThrow(/origin-relative/);
  });
});

describe('normalizeRoutePath (P3-TRAILING-SLASH)', () => {
  it('keeps the root path as a single slash', () => {
    expect(normalizeRoutePath('/')).toBe('/');
    expect(normalizeRoutePath('//')).toBe('/');
    expect(normalizeRoutePath('')).toBe('/');
  });

  it('drops trailing slashes so a bookmarked URL still resolves', () => {
    // `/knowledge/` used to miss the route table and redirect to the chat page.
    expect(normalizeRoutePath('/knowledge/')).toBe('/knowledge');
    expect(normalizeRoutePath('/knowledge///')).toBe('/knowledge');
    expect(normalizeRoutePath('/rag-eval/')).toBe('/rag-eval');
  });

  it('lower-cases the path so casing does not change the route', () => {
    expect(normalizeRoutePath('/Knowledge')).toBe('/knowledge');
    expect(normalizeRoutePath('/RAG-Eval/')).toBe('/rag-eval');
    expect(normalizeRoutePath('/LOGIN')).toBe('/login');
  });

  it('leaves an already canonical path untouched', () => {
    expect(normalizeRoutePath('/profile')).toBe('/profile');
  });
});

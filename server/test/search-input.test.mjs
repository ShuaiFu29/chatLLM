import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const {
  MAX_SEARCH_QUERY_LENGTH,
  normalizeSearchQuery,
  readSearchFilters,
} = require(path.join(serverRoot, 'dist', 'lib', 'searchInput.js'));

test('normalizeSearchQuery trims valid search queries', () => {
  assert.deepEqual(normalizeSearchQuery('  error budget  '), {
    ok: true,
    query: 'error budget',
  });
});

test('normalizeSearchQuery rejects missing blank and oversized queries', () => {
  assert.deepEqual(normalizeSearchQuery(undefined), {
    ok: false,
    statusCode: 400,
    error: 'Search query is required',
  });
  assert.deepEqual(normalizeSearchQuery('   '), {
    ok: false,
    statusCode: 400,
    error: 'Search query is required',
  });
  assert.deepEqual(normalizeSearchQuery('x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1)), {
    ok: false,
    statusCode: 413,
    error: `Search query exceeds ${MAX_SEARCH_QUERY_LENGTH} characters`,
  });
});

test('readSearchFilters normalizes supported message search filters', () => {
  assert.deepEqual(readSearchFilters({
    projectSpaceId: ' space-1 ',
    hasSources: '1',
    model: ' deepseek-chat ',
    favoriteOnly: 'true',
    tag: ' release ',
    includeArchived: 'false',
    limit: '999',
  }), {
    projectSpaceId: 'space-1',
    hasSources: true,
    model: 'deepseek-chat',
    favoriteOnly: true,
    tag: 'release',
    includeArchived: false,
    limit: 50,
  });
});

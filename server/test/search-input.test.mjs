import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('search uses a Nest-native controller and preserves validation responses', async () => {
  const controllerSource = readFileSync(
    path.join(serverRoot, 'src/modules/search/search.controller.ts'),
    'utf8',
  );
  const moduleSource = readFileSync(
    path.join(serverRoot, 'src/modules/search/search.module.ts'),
    'utf8',
  );
  assert.match(controllerSource, /@CurrentUser\(\) user: User/);
  assert.match(controllerSource, /@Query\(\) query: Record<string, unknown>/);
  assert.match(controllerSource, /this\.searchService\.search\(user\.id, query, requestId\)/);
  assert.doesNotMatch(controllerSource, /@(?:Req|Res)\(|App(?:Request|Reply)/);
  assert.match(moduleSource, /providers: \[AuthGuard, SearchService\]/);

  const { SearchService } = require(path.join(
    serverRoot,
    'dist/modules/search/search.service.js',
  ));
  const service = new SearchService();
  await assert.rejects(
    service.search('user-1', {}),
    (error) => {
      assert.equal(error.getStatus(), 400);
      assert.deepEqual(error.getResponse(), { error: 'Search query is required' });
      return true;
    },
  );
});

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

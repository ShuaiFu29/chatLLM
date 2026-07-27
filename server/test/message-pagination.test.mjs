import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');

test('message page query defaults to a bounded recent page and rejects invalid input', () => {
  const {
    DEFAULT_MESSAGE_PAGE_LIMIT,
    MAX_MESSAGE_PAGE_LIMIT,
    normalizeMessagePageQuery,
  } = require(path.join(serverRoot, 'dist', 'lib', 'messagePagination.js'));

  assert.deepEqual(normalizeMessagePageQuery({}), {
    ok: true,
    limit: DEFAULT_MESSAGE_PAGE_LIMIT,
    cursor: null,
  });

  assert.deepEqual(normalizeMessagePageQuery({ limit: String(MAX_MESSAGE_PAGE_LIMIT + 500) }), {
    ok: true,
    limit: MAX_MESSAGE_PAGE_LIMIT,
    cursor: null,
  });

  assert.deepEqual(normalizeMessagePageQuery({ limit: '0' }), {
    ok: false,
    statusCode: 400,
    error: 'Message page limit must be a positive integer',
  });

  assert.deepEqual(normalizeMessagePageQuery({ cursor: 'not-a-valid-cursor' }), {
    ok: false,
    statusCode: 400,
    error: 'Invalid message cursor',
  });
});

test('message cursors round-trip created time and id without exposing raw SQL fragments', () => {
  const {
    decodeMessageCursor,
    encodeMessageCursor,
  } = require(path.join(serverRoot, 'dist', 'lib', 'messagePagination.js'));

  const cursor = encodeMessageCursor({
    id: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-06-29T10:11:12.000Z',
  });

  assert.equal(typeof cursor, 'string');
  assert.equal(cursor.includes('2026-06-29'), false);
  assert.deepEqual(decodeMessageCursor(cursor), {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-06-29T10:11:12.000Z',
  });
});

test('chat message listing uses cursor pagination and exposes page metadata headers', () => {
  const repositorySource = readSource('src/repositories/messages.ts');
  const controllerSource = readSource('src/controllers/chat.ts');
  const nestControllerSource = readSource('src/modules/chat/chat.controller.ts');
  const mainSource = readSource('src/main.ts');
  const storeSource = readSource('../client/src/stores/useChatStore.ts');

  assert.match(repositorySource, /listMessagesForConversationPage/);
  assert.match(repositorySource, /\((?:m\.)?created_at,\s*(?:m\.)?id\)\s*<\s*\(\$/);
  assert.match(repositorySource, /order by (?:m\.)?created_at desc,\s*(?:m\.)?id desc/i);
  assert.match(repositorySource, /limit \$\d+/);
  assert.match(repositorySource, /hasMore/);
  assert.match(repositorySource, /\.reverse\(\)/);

  assert.match(controllerSource, /normalizeMessagePageQuery\(req\.query\)/);
  assert.match(controllerSource, /x-chatllm-has-more/);
  assert.match(controllerSource, /x-chatllm-next-cursor/);
  assert.match(controllerSource, /x-chatllm-page-limit/);
  assert.match(controllerSource, /listMessagesForConversationPage/);
  assert.match(controllerSource, /res\.header\('x-chatllm-has-more'/);
  assert.match(controllerSource, /res\.header\('x-chatllm-next-cursor'/);
  assert.match(controllerSource, /res\.send\(page\.messages\)/);

  assert.match(nestControllerSource, /@Get\('conversations\/:conversationId\/messages'\)/);
  assert.match(nestControllerSource, /return getMessages\(request, reply\)/);
  assert.match(mainSource, /exposedHeaders/);
  assert.match(mainSource, /x-chatllm-next-cursor/);

  assert.match(storeSource, /messagePagination/);
  assert.match(storeSource, /loadOlderMessages/);
  assert.match(storeSource, /x-chatllm-has-more/);
  assert.match(storeSource, /x-chatllm-next-cursor/);
});

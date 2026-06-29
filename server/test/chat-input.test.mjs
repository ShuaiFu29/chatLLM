import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const { normalizeChatMessageContent, MAX_CHAT_MESSAGE_CONTENT_LENGTH } = require(path.join(
  serverRoot,
  'dist',
  'lib',
  'chatInput.js'
));

test('normalizeChatMessageContent trims valid chat messages', () => {
  assert.deepEqual(normalizeChatMessageContent('  hello  '), {
    ok: true,
    content: 'hello',
  });
});

test('normalizeChatMessageContent rejects missing and blank chat messages', () => {
  assert.deepEqual(normalizeChatMessageContent(undefined), {
    ok: false,
    statusCode: 400,
    error: 'Content is required',
  });
  assert.deepEqual(normalizeChatMessageContent('   '), {
    ok: false,
    statusCode: 400,
    error: 'Content is required',
  });
});

test('normalizeChatMessageContent rejects chat messages above the bounded length', () => {
  assert.deepEqual(normalizeChatMessageContent('x'.repeat(MAX_CHAT_MESSAGE_CONTENT_LENGTH + 1)), {
    ok: false,
    statusCode: 413,
    error: `Content exceeds ${MAX_CHAT_MESSAGE_CONTENT_LENGTH} characters`,
  });
  assert.equal(normalizeChatMessageContent('x'.repeat(MAX_CHAT_MESSAGE_CONTENT_LENGTH)).ok, true);
});

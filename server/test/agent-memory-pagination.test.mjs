import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  decodeAgentMemoryCursor,
  encodeAgentMemoryCursor,
  normalizeAgentMemorySearch,
} = require(path.join(serverRoot, 'dist', 'lib', 'agentMemoryCursor.js'));
const {
  AgentMemorySafetyError,
  assertAgentMemoryContentSafe,
  inspectAgentMemoryContent,
} = require(path.join(serverRoot, 'dist', 'lib', 'agentMemorySafety.js'));

test('Agent Memory cursor round-trips only the stable page boundary', () => {
  const boundary = {
    createdAt: '2026-08-29T03:04:05.678Z',
    id: '11111111-1111-4111-8111-111111111111',
  };
  const cursor = encodeAgentMemoryCursor(boundary);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeAgentMemoryCursor(cursor), boundary);
  assert.equal(decodeAgentMemoryCursor(undefined), null);
  assert.equal(decodeAgentMemoryCursor(''), null);
});

test('Agent Memory cursor rejects tampering, extra sort keys and invalid boundaries', () => {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  for (const invalid of [
    'not-json',
    `${encode({ created_at: '2026-08-29T03:04:05.678Z', id: '11111111-1111-4111-8111-111111111111' })}x`,
    encode({ created_at: 'not-a-date', id: '11111111-1111-4111-8111-111111111111' }),
    encode({ created_at: '2026-08-29T03:04:05.678Z', id: 'not-a-uuid' }),
    encode({
      created_at: '2026-08-29T03:04:05.678Z',
      id: '11111111-1111-4111-8111-111111111111',
      order: 'asc',
    }),
    'x'.repeat(513),
  ]) {
    assert.throws(() => decodeAgentMemoryCursor(invalid), /Invalid Agent Memory cursor/);
  }
});

test('Agent Memory search is trimmed and bounded', () => {
  assert.equal(normalizeAgentMemorySearch('  中文 preference  '), '中文 preference');
  assert.equal(normalizeAgentMemorySearch('   '), undefined);
  assert.throws(() => normalizeAgentMemorySearch(['unexpected']), /Invalid Agent Memory search/);
  assert.throws(() => normalizeAgentMemorySearch('x'.repeat(201)), /too long/);
});

test('Agent Memory blocks credential material and classifies personal identifiers', () => {
  for (const secret of [
    'api_key = abcdefghijklmnopqrstuvwxyz',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    '-----BEGIN PRIVATE KEY-----\nnot-for-memory',
    'token: ghp_abcdefghijklmnopqrstuvwxyz123456',
    'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345678',
  ]) {
    assert.throws(
      () => assertAgentMemoryContentSafe(secret),
      (error) => error instanceof AgentMemorySafetyError
        && error.code === 'AGENT_MEMORY_SENSITIVE_CONTENT',
    );
  }
  assert.deepEqual(inspectAgentMemoryContent('Contact me at person@example.com.'), {
    sensitivity: 'sensitive',
    blockedReason: null,
  });
  assert.deepEqual(inspectAgentMemoryContent('Prefers concise Chinese answers.'), {
    sensitivity: 'personal',
    blockedReason: null,
  });
});

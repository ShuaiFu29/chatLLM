import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';


const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const sessionsModule = require(path.join(serverRoot, 'dist', 'repositories', 'sessions.js'));
const sessionsSource = readFileSync(path.join(serverRoot, 'src', 'repositories', 'sessions.ts'), 'utf8');
const authSource = readFileSync(path.join(serverRoot, 'src', 'modules', 'auth', 'auth.service.ts'), 'utf8');


test('hashRefreshToken returns the stable 64-character SHA-256 digest', () => {
  assert.equal(typeof sessionsModule.hashRefreshToken, 'function');
  assert.equal(
    sessionsModule.hashRefreshToken('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(sessionsModule.hashRefreshToken('another-token').length, 64);
});


test('session repository persists and queries token hashes instead of raw refresh tokens', () => {
  assert.match(sessionsSource, /createHash\('sha256'\)\.update\(rawToken, 'utf8'\)\.digest\('hex'\)/);
  assert.match(
    sessionsSource,
    /insert into sessions \(token_hash, user_id, expires_at, remember_me\)/,
  );
  assert.match(sessionsSource, /where s\.token_hash = \$1/);
  assert.match(sessionsSource, /delete from sessions where token_hash = \$1/);
  assert.match(sessionsSource, /and expires_at > now\(\)/);
  assert.match(sessionsSource, /returning user_id/);
  assert.match(sessionsSource, /return runInTransaction\(async \(client\) =>/);
  assert.doesNotMatch(sessionsSource, /insert into sessions \(id, user_id, expires_at\)/);
});


test('AuthService generates random 32-byte refresh tokens and rotates them atomically', () => {
  const refreshBody = authSource
    .split('async refresh(', 2)[1]
    .split('async getMe(', 1)[0];

  assert.match(authSource, /randomBytes\(32\)\.toString\('base64url'\)/);
  assert.doesNotMatch(authSource, /randomUUID\(\)/);
  assert.match(
    refreshBody,
    /rotateSession\([\s\S]*oldRefreshToken,[\s\S]*newRefreshToken/,
  );
  assert.doesNotMatch(refreshBody, /getSessionExpiries\(\)/);
  assert.match(
    refreshBody,
    /setAuthCookies\([\s\S]*session\.remember_me,[\s\S]*session\.expires_at/,
  );
  assert.doesNotMatch(refreshBody, /findSessionWithUser\(/);
  assert.doesNotMatch(refreshBody, /deleteSession\(/);
  assert.doesNotMatch(refreshBody, /createSession\(/);
});


test('concurrent rotations of one raw token produce exactly one replacement session', async () => {
  assert.equal(typeof sessionsModule.rotateSession, 'function');
  assert.equal(typeof sessionsModule.hashRefreshToken, 'function');

  const oldRawToken = 'old-refresh-token-that-must-never-reach-the-database';
  const replacementTokens = [
    'replacement-token-one-that-must-never-reach-the-database',
    'replacement-token-two-that-must-never-reach-the-database',
  ];
  const oldHash = sessionsModule.hashRefreshToken(oldRawToken);
  let activeHash = oldHash;
  let insertedSessions = 0;
  const calls = [];
  const userId = 'd4bf7f87-0769-486c-bdb8-351df9f6cb38';
  const expiresAt = '2099-01-07T00:00:00.000Z';

  const runInTransaction = async (callback) => callback({
    query: async (text, params = []) => {
      calls.push({ text, params: [...params] });
      const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();

      if (normalized.startsWith('delete from sessions')) {
        await new Promise((resolve) => setImmediate(resolve));
        if (activeHash !== params[0]) return { rows: [], rowCount: 0 };
        activeHash = null;
        return { rows: [{ user_id: userId }], rowCount: 1 };
      }

      if (normalized.startsWith('select user_id') && normalized.includes('from sessions')) {
        return activeHash === params[0]
          ? {
              rows: [{ user_id: userId, remember_me: true, expires_at: expiresAt }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith('insert into sessions')) {
        insertedSessions += 1;
        activeHash = params[0];
        return {
          rows: [{
            id: `new-session-${insertedSessions}`,
            user_id: userId,
            expires_at: params[2],
            remember_me: params[3],
            created_at: '2026-07-12T00:00:00.000Z',
          }],
          rowCount: 1,
        };
      }

      if (normalized.includes('from users')) {
        return {
          rows: [{
            id: userId,
            github_id: '9007199254740993',
            username: 'octocat',
            avatar_url: '',
            avatar_object_key: null,
            display_name: 'Octo Cat',
            settings: {},
            deletion_status: 'active',
            created_at: '2026-07-12T00:00:00.000Z',
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected SQL in fake transaction: ${text}`);
    },
  });

  const results = await Promise.all(replacementTokens.map((replacement) =>
    sessionsModule.rotateSession(oldRawToken, replacement, runInTransaction)
  ));

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(insertedSessions, 1);
  assert.equal(results.find(Boolean).user.id, userId);
  assert.equal(results.find(Boolean).user.github_id, '9007199254740993');
  assert.equal(results.find(Boolean).remember_me, true);
  assert.equal(results.find(Boolean).expires_at, expiresAt);
  assert.ok(replacementTokens.map(sessionsModule.hashRefreshToken).includes(activeHash));

  const databaseArguments = JSON.stringify(calls.map((call) => call.params));
  assert.doesNotMatch(databaseArguments, new RegExp(oldRawToken));
  for (const replacement of replacementTokens) {
    assert.doesNotMatch(databaseArguments, new RegExp(replacement));
  }
});

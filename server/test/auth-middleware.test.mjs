import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://chatllm:chatllm@localhost:5432/chatllm';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_ACCESS_KEY = 'minioadmin';
process.env.S3_SECRET_KEY = 'minioadmin';
process.env.JWT_SECRET = 'local-random-secret-with-more-than-32-characters';
process.env.DEEPSEEK_API_KEY = 'sk-test';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const { generateAccessToken } = require(path.join(serverRoot, 'dist', 'lib', 'jwt.js'));
const { resolveAuthenticatedUser } = require(path.join(serverRoot, 'dist', 'middleware', 'auth.js'));
const authControllerSource = readFileSync(path.join(serverRoot, 'src', 'controllers', 'auth.ts'), 'utf8');

test('resolveAuthenticatedUser returns the current database user rather than stale token fields', async () => {
  const token = generateAccessToken({
    id: 'd4bf7f87-0769-486c-bdb8-351df9f6cb38',
    github_id: 12345,
    username: 'old-name',
    avatar_url: 'https://example.com/old.png',
    display_name: 'Old Name',
  });

  const databaseUser = {
    id: 'd4bf7f87-0769-486c-bdb8-351df9f6cb38',
    github_id: 12345,
    username: 'new-name',
    avatar_url: 'https://example.com/new.png',
    display_name: 'New Name',
    settings: { model: 'deepseek-chat' },
  };

  const user = await resolveAuthenticatedUser(token, async (userId) => {
    assert.equal(userId, databaseUser.id);
    return databaseUser;
  });

  assert.deepEqual(user, databaseUser);
});

test('resolveAuthenticatedUser does not query the database for invalid tokens', async () => {
  let databaseWasQueried = false;

  const user = await resolveAuthenticatedUser('not-a-valid-token', async () => {
    databaseWasQueried = true;
    return null;
  });

  assert.equal(user, null);
  assert.equal(databaseWasQueried, false);
});

test('GitHub OAuth state cookie uses the same baseline security options as auth cookies', () => {
  assert.match(authControllerSource, /github_oauth_state'[\s\S]*httpOnly:\s*true/);
  assert.match(authControllerSource, /github_oauth_state'[\s\S]*secure:\s*process\.env\.NODE_ENV === 'production'/);
  assert.match(authControllerSource, /github_oauth_state'[\s\S]*sameSite:\s*'lax'/);
  assert.match(authControllerSource, /github_oauth_state'[\s\S]*path:\s*'\/api\/auth'/);
  assert.match(authControllerSource, /clearCookie\('github_oauth_state',\s*\{\s*path:\s*'\/api\/auth'\s*\}\)/);
});

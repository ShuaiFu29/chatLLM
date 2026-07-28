import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
const passwordModule = require(path.join(serverRoot, 'dist', 'lib', 'password.js'));
const usersModule = require(path.join(serverRoot, 'dist', 'repositories', 'users.js'));
const sessionsModule = require(path.join(serverRoot, 'dist', 'repositories', 'sessions.js'));
const undiciModule = require('undici');
const { AuthService } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'auth',
  'auth.service.js',
));

const localUser = {
  id: 'd4bf7f87-0769-486c-bdb8-351df9f6cb38',
  github_id: null,
  username: 'Ada',
  avatar_url: '',
  avatar_object_key: null,
  display_name: 'Ada',
  settings: {},
  deletion_status: 'active',
  created_at: '2026-07-28T00:00:00.000Z',
};

test('password hashes are salted, versioned, and verified with scrypt', async () => {
  const first = await passwordModule.hashPassword('correct horse battery staple');
  const second = await passwordModule.hashPassword('correct horse battery staple');

  assert.match(first, /^scrypt\$v1\$32768\$8\$1\$/);
  assert.notEqual(first, second);
  assert.equal(await passwordModule.verifyPassword('correct horse battery staple', first), true);
  assert.equal(await passwordModule.verifyPassword('wrong password', first), false);
  assert.equal(await passwordModule.verifyPassword('correct horse battery staple', 'sha256$bad'), false);
  assert.equal(await passwordModule.verifyPassword(
    'correct horse battery staple',
    `${first}$trailing-data`,
  ), false);
});

test('registration stores only a password hash and creates a persistent seven-day session', async () => {
  const originals = {
    createLocalUser: usersModule.createLocalUser,
    createSession: sessionsModule.createSession,
  };
  let userInput;
  let sessionInput;
  usersModule.createLocalUser = async (input) => {
    userInput = input;
    return localUser;
  };
  sessionsModule.createSession = async (...input) => {
    sessionInput = input;
  };

  try {
    const startedAt = Date.now();
    const result = await new AuthService().register({
      email: 'ada@example.com',
      password: 'correct horse battery staple',
      displayName: 'Ada',
      rememberMe: true,
    });

    assert.equal(result.options.statusCode, 201);
    assert.deepEqual(result.body, { user: localUser });
    assert.equal(userInput.email, 'ada@example.com');
    assert.equal(userInput.displayName, 'Ada');
    assert.notEqual(userInput.passwordHash, 'correct horse battery staple');
    assert.equal(await passwordModule.verifyPassword(
      'correct horse battery staple',
      userInput.passwordHash,
    ), true);
    assert.equal(sessionInput[1], localUser.id);
    assert.equal(sessionInput[3], true);
    assert.ok(Date.parse(sessionInput[2]) - startedAt >= 7 * 24 * 60 * 60 * 1000 - 2000);

    const accessCookie = result.options.cookies.find(({ name }) => name === 'access_token');
    const refreshCookie = result.options.cookies.find(({ name }) => name === 'refresh_token');
    assert.equal(accessCookie.options.maxAge, 15 * 60);
    assert.ok(refreshCookie.options.maxAge <= 7 * 24 * 60 * 60);
    assert.ok(refreshCookie.options.maxAge >= 7 * 24 * 60 * 60 - 2);
    assert.ok(accessCookie.options.expires instanceof Date);
    assert.ok(refreshCookie.options.expires instanceof Date);
  } finally {
    usersModule.createLocalUser = originals.createLocalUser;
    sessionsModule.createSession = originals.createSession;
  }
});

test('non-remembered login uses browser-session cookies and a short server session', async () => {
  const originals = {
    findUserCredentialsByEmail: usersModule.findUserCredentialsByEmail,
    createSession: sessionsModule.createSession,
  };
  const passwordHash = await passwordModule.hashPassword('password123');
  let sessionInput;
  usersModule.findUserCredentialsByEmail = async () => ({ user: localUser, passwordHash });
  sessionsModule.createSession = async (...input) => {
    sessionInput = input;
  };

  try {
    const startedAt = Date.now();
    const result = await new AuthService().login({
      email: 'ada@example.com',
      password: 'password123',
      rememberMe: false,
    });

    assert.deepEqual(result.body, { user: localUser });
    assert.equal(sessionInput[3], false);
    const sessionDuration = Date.parse(sessionInput[2]) - startedAt;
    assert.ok(sessionDuration >= 24 * 60 * 60 * 1000 - 2000);
    assert.ok(sessionDuration <= 24 * 60 * 60 * 1000 + 2000);
    for (const cookie of result.options.cookies) {
      assert.equal(cookie.options.maxAge, undefined);
      assert.equal(cookie.options.expires, undefined);
    }
  } finally {
    usersModule.findUserCredentialsByEmail = originals.findUserCredentialsByEmail;
    sessionsModule.createSession = originals.createSession;
  }
});

test('login returns one generic failure for missing users and wrong passwords', async () => {
  const originalFind = usersModule.findUserCredentialsByEmail;
  const passwordHash = await passwordModule.hashPassword('password123');

  try {
    usersModule.findUserCredentialsByEmail = async () => null;
    const missing = await new AuthService().login({
      email: 'missing@example.com',
      password: 'password123',
      rememberMe: false,
    });

    usersModule.findUserCredentialsByEmail = async () => ({ user: localUser, passwordHash });
    const wrong = await new AuthService().login({
      email: 'ada@example.com',
      password: 'wrong-password',
      rememberMe: false,
    });

    assert.equal(missing.options.statusCode, 401);
    assert.equal(wrong.options.statusCode, 401);
    assert.deepEqual(missing.body, { error: 'Invalid email or password' });
    assert.deepEqual(wrong.body, missing.body);
  } finally {
    usersModule.findUserCredentialsByEmail = originalFind;
  }
});

test('refresh preserves the remembered session absolute expiry instead of extending seven days', async () => {
  const originalRotateSession = sessionsModule.rotateSession;
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  let rotationInput;
  sessionsModule.rotateSession = async (...input) => {
    rotationInput = input;
    return {
      id: 'rotated-session',
      user_id: localUser.id,
      expires_at: expiresAt,
      remember_me: true,
      created_at: '2026-07-28T00:00:00.000Z',
      user: localUser,
    };
  };

  try {
    const result = await new AuthService().refresh({ refresh_token: 'old-token' });
    assert.equal(rotationInput.length, 2);
    assert.equal(rotationInput[0], 'old-token');
    const refreshCookie = result.options.cookies.find(({ name }) => name === 'refresh_token');
    assert.equal(refreshCookie.options.expires.toISOString(), expiresAt);
    assert.ok(refreshCookie.options.maxAge <= 3 * 24 * 60 * 60);
    assert.ok(refreshCookie.options.maxAge >= 3 * 24 * 60 * 60 - 2);
  } finally {
    sessionsModule.rotateSession = originalRotateSession;
  }
});

test('GitHub callback carries the trusted OAuth remember cookie into the session policy', async () => {
  const originals = {
    fetch: undiciModule.fetch,
    findUserByGithubId: usersModule.findUserByGithubId,
    createSession: sessionsModule.createSession,
  };
  const sessions = [];
  undiciModule.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(
      String(url).includes('access_token')
        ? { access_token: 'github-access-token' }
        : {
            id: 12345,
            login: 'octocat',
            avatar_url: 'https://example.com/avatar.png',
            name: 'Octo Cat',
          },
    ),
  });
  usersModule.findUserByGithubId = async () => ({
    ...localUser,
    github_id: 12345,
    username: 'octocat',
    display_name: 'Octo Cat',
  });
  sessionsModule.createSession = async (...input) => {
    sessions.push(input);
  };

  try {
    const service = new AuthService();
    const remembered = await service.githubCallback({
      code: 'oauth-code',
      state: 'remembered-state',
      cookies: {
        github_oauth_state: 'remembered-state',
        github_oauth_remember: '1',
      },
    });
    const browserSession = await service.githubCallback({
      code: 'oauth-code',
      state: 'browser-state',
      cookies: {
        github_oauth_state: 'browser-state',
        github_oauth_remember: '0',
      },
    });

    assert.equal(sessions[0][3], true);
    assert.equal(sessions[1][3], false);
    const rememberedRefresh = remembered.options.cookies.find(({ name }) => name === 'refresh_token');
    const browserRefresh = browserSession.options.cookies.find(({ name }) => name === 'refresh_token');
    assert.ok(rememberedRefresh.options.maxAge <= 7 * 24 * 60 * 60);
    assert.ok(rememberedRefresh.options.maxAge >= 7 * 24 * 60 * 60 - 2);
    assert.equal(browserRefresh.options.maxAge, undefined);
    assert.deepEqual(
      remembered.options.cookies.slice(0, 2).map(({ action, name }) => [action, name]),
      [
        ['clear', 'github_oauth_state'],
        ['clear', 'github_oauth_remember'],
      ],
    );
  } finally {
    undiciModule.fetch = originals.fetch;
    usersModule.findUserByGithubId = originals.findUserByGithubId;
    sessionsModule.createSession = originals.createSession;
  }
});

test('duplicate registration is translated to a safe conflict response', async () => {
  const originals = {
    createLocalUser: usersModule.createLocalUser,
    hashPassword: passwordModule.hashPassword,
  };
  passwordModule.hashPassword = async () => 'scrypt$v1$test';
  usersModule.createLocalUser = async () => {
    throw new usersModule.EmailAlreadyRegisteredError();
  };

  try {
    const result = await new AuthService().register({
      email: 'ada@example.com',
      password: 'password123',
      displayName: 'Ada',
      rememberMe: false,
    });
    assert.equal(result.options.statusCode, 409);
    assert.deepEqual(result.body, { error: 'Email is already registered' });
  } finally {
    usersModule.createLocalUser = originals.createLocalUser;
    passwordModule.hashPassword = originals.hashPassword;
  }
});

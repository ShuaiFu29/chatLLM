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
const authenticationModule = require(path.join(serverRoot, 'dist', 'services', 'authentication.js'));
const { resolveAuthenticatedUser } = authenticationModule;
const { AuthGuard } = require(path.join(serverRoot, 'dist', 'common', 'guards', 'auth.guard.js'));
const { AuthController } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'auth',
  'auth.controller.js',
));
const { AuthService } = require(path.join(serverRoot, 'dist', 'modules', 'auth', 'auth.service.js'));
const authControllerSource = readFileSync(path.join(serverRoot, 'src', 'modules', 'auth', 'auth.service.ts'), 'utf8');
const authNestControllerSource = readFileSync(
  path.join(serverRoot, 'src', 'modules', 'auth', 'auth.controller.ts'),
  'utf8',
);
const authModuleSource = readFileSync(
  path.join(serverRoot, 'src', 'modules', 'auth', 'auth.module.ts'),
  'utf8',
);

const createExecutionContext = (request) => ({
  switchToHttp: () => ({
    getRequest: () => request,
  }),
});

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
    deletion_status: 'active',
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

test('resolveAuthenticatedUser rejects users whose deletion is pending', async () => {
  const token = generateAccessToken({
    id: 'd4bf7f87-0769-486c-bdb8-351df9f6cb38',
    github_id: 12345,
    username: 'pending-user',
    avatar_url: '',
    display_name: 'Pending User',
  });
  let queriedUserId;

  const user = await resolveAuthenticatedUser(token, async (userId) => {
    queriedUserId = userId;
    return {
      id: userId,
      deletion_status: 'pending',
    };
  });

  assert.equal(queriedUserId, 'd4bf7f87-0769-486c-bdb8-351df9f6cb38');
  assert.equal(user, null);
});

test('AuthGuard uses Fastify cookies and attaches the current database user', async () => {
  const originalResolveAuthenticatedUser = authenticationModule.resolveAuthenticatedUser;
  const databaseUser = {
    id: 'd4bf7f87-0769-486c-bdb8-351df9f6cb38',
    deletion_status: 'active',
    username: 'current-user',
  };
  const request = { cookies: { access_token: 'signed-access-token' } };
  let receivedToken;
  authenticationModule.resolveAuthenticatedUser = async (accessToken) => {
    receivedToken = accessToken;
    return databaseUser;
  };

  try {
    assert.equal(await new AuthGuard().canActivate(createExecutionContext(request)), true);
  } finally {
    authenticationModule.resolveAuthenticatedUser = originalResolveAuthenticatedUser;
  }

  assert.equal(receivedToken, 'signed-access-token');
  assert.deepEqual(request.user, databaseUser);
});

test('AuthGuard rejects requests without an access token before authentication lookup', async () => {
  const originalResolveAuthenticatedUser = authenticationModule.resolveAuthenticatedUser;
  let authenticationWasCalled = false;
  authenticationModule.resolveAuthenticatedUser = async () => {
    authenticationWasCalled = true;
    return null;
  };

  try {
    await assert.rejects(
      new AuthGuard().canActivate(createExecutionContext({ cookies: {} })),
      (error) => error.getStatus() === 401
        && assert.deepEqual(error.getResponse(), { error: 'Unauthorized: No access token' }) === undefined,
    );
  } finally {
    authenticationModule.resolveAuthenticatedUser = originalResolveAuthenticatedUser;
  }

  assert.equal(authenticationWasCalled, false);
});

test('GitHub OAuth state cookie uses the same baseline security options as auth cookies', () => {
  assert.match(authControllerSource, /name:\s*'github_oauth_state'[\s\S]*httpOnly:\s*true/);
  assert.match(authControllerSource, /name:\s*'github_oauth_state'[\s\S]*secure:\s*process\.env\.NODE_ENV === 'production'/);
  assert.match(authControllerSource, /name:\s*'github_oauth_state'[\s\S]*sameSite:\s*'lax'/);
  assert.match(authControllerSource, /name:\s*'github_oauth_state'[\s\S]*path:\s*'\/api\/auth'/);
  assert.match(authControllerSource, /action:\s*'clear'[\s\S]*name:\s*'github_oauth_state'[\s\S]*path:\s*'\/api\/auth'/);
});

test('AuthController delegates plain Nest values without native request or reply parameters', async () => {
  const calls = [];
  const results = {
    githubLogin: { route: 'github-login' },
    register: { route: 'register' },
    login: { route: 'login' },
    githubCallback: { route: 'github-callback' },
    refresh: { route: 'refresh' },
    getMe: { route: 'me' },
    updateProfile: { route: 'update' },
    deleteAccount: { route: 'delete' },
    logout: { route: 'logout' },
  };
  const service = Object.fromEntries(Object.entries(results).map(([method, result]) => [
    method,
    (...args) => {
      calls.push([method, ...args]);
      return result;
    },
  ]));
  const controller = new AuthController(service);
  const user = { id: 'auth-user' };
  const cookies = { refresh_token: 'refresh-token' };
  const profile = { display_name: 'Ada' };
  const loginInput = {
    email: 'ada@example.com',
    password: 'password123',
    rememberMe: true,
  };
  const registerInput = { ...loginInput, displayName: 'Ada' };

  assert.equal(controller.githubLogin('true'), results.githubLogin);
  assert.equal(controller.register(registerInput, 'request-register'), results.register);
  assert.equal(controller.login(loginInput, 'request-login'), results.login);
  assert.equal(
    controller.githubCallback('oauth-code', 'oauth-state', cookies, 'request-callback'),
    results.githubCallback,
  );
  assert.equal(controller.refresh(cookies, 'request-refresh'), results.refresh);
  assert.equal(controller.me(user), results.getMe);
  assert.equal(controller.update(user, profile), results.updateProfile);
  assert.equal(controller.delete(user, 'request-delete'), results.deleteAccount);
  assert.equal(controller.logout(cookies), results.logout);
  assert.deepEqual(calls, [
    ['githubLogin', true],
    ['register', registerInput, 'request-register'],
    ['login', loginInput, 'request-login'],
    ['githubCallback', {
      code: 'oauth-code',
      state: 'oauth-state',
      cookies,
      requestId: 'request-callback',
    }],
    ['refresh', cookies, 'request-refresh'],
    ['getMe', user],
    ['updateProfile', user, profile],
    ['deleteAccount', user, 'request-delete'],
    ['logout', cookies],
  ]);
  assert.doesNotMatch(authNestControllerSource, /@(Req|Res)\s*\(/);
  assert.doesNotMatch(authNestControllerSource, /\b(?:AppReply|AppRequest)\b/);
  assert.match(authModuleSource, /providers:\s*\[AuthGuard, AuthService\]/);
});

test('AuthService expresses redirects, failures, and cookie clearing as Nest response metadata', async () => {
  const service = new AuthService();
  const login = service.githubLogin();
  const missingCode = await service.githubCallback({
    cookies: {},
    requestId: 'request-missing-code',
  });
  const missingRefresh = await service.refresh({}, 'request-missing-refresh');
  const logout = await service.logout({});

  assert.equal(login.options.statusCode, 302);
  assert.match(login.options.headers.Location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.equal(login.options.cookies[0].action, 'set');
  assert.equal(login.options.cookies[0].name, 'github_oauth_state');
  assert.equal(login.options.cookies[1].name, 'github_oauth_remember');
  assert.equal(login.options.cookies[1].value, '0');
  assert.equal(service.githubLogin(true).options.cookies[1].value, '1');
  assert.deepEqual(missingCode.body, { error: 'Missing code' });
  assert.equal(missingCode.options.statusCode, 400);
  assert.deepEqual(missingRefresh.body, { error: 'No refresh token provided' });
  assert.equal(missingRefresh.options.statusCode, 401);
  assert.deepEqual(logout.body, {
    message: 'Logged out',
    github_logout_url: 'https://github.com/logout',
  });
  assert.deepEqual(
    logout.options.cookies.map(({ action, name, options }) => [action, name, options.path]),
    [
      ['clear', 'access_token', '/'],
      ['clear', 'refresh_token', '/api/auth'],
      ['clear', 'refresh_token', '/api/auth/refresh'],
    ],
  );
});

test('AuthModule emits redirects and cookies through the Nest response pipeline', async () => {
  const cookie = require('@fastify/cookie');
  const { FastifyAdapter } = require('@nestjs/platform-fastify');
  const { Test } = require('@nestjs/testing');
  const { AuthModule } = require(path.join(
    serverRoot,
    'dist',
    'modules',
    'auth',
    'auth.module.js',
  ));
  const { HttpResponseInterceptor } = require(path.join(
    serverRoot,
    'dist',
    'common',
    'interceptors',
    'http-response.interceptor.js',
  ));
  const testingModule = await Test.createTestingModule({ imports: [AuthModule] }).compile();
  const app = testingModule.createNestApplication(new FastifyAdapter());
  app.setGlobalPrefix('api');
  app.useGlobalInterceptors(new HttpResponseInterceptor());
  await app.register(cookie);

  try {
    await app.init();
    const login = await app.inject({ method: 'GET', url: '/api/auth/github/login' });
    const callback = await app.inject({ method: 'GET', url: '/api/auth/github/callback' });
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: {},
    });
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: {},
    });

    assert.equal(login.statusCode, 302);
    assert.match(login.headers.location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    assert.match(String(login.headers['set-cookie']), /github_oauth_state=/);
    assert.equal(callback.statusCode, 400);
    assert.deepEqual(callback.json(), { error: 'Missing code' });
    assert.equal(refresh.statusCode, 401);
    assert.deepEqual(refresh.json(), { error: 'No refresh token provided' });
    assert.equal(logout.statusCode, 200);
    assert.deepEqual(logout.json(), {
      message: 'Logged out',
      github_logout_url: 'https://github.com/logout',
    });
    assert.match(String(logout.headers['set-cookie']), /access_token=/);
  } finally {
    await app.close();
  }
});

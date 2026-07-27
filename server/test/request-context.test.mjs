import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  readCurrentUser,
  readRequestConnection,
  readRequestCookies,
  readRequestId,
} = require(path.join(
  serverRoot,
  'dist',
  'common',
  'http',
  'request-context.decorator.js',
));

const createContext = (request) => ({
  switchToHttp: () => ({ getRequest: () => request }),
});

test('CurrentUser exposes the authenticated guard context without a Fastify response', () => {
  const user = { id: 'user-one', username: 'ada' };
  assert.equal(readCurrentUser(undefined, createContext({ user })), user);
});

test('CurrentUser fails closed when a controller forgets AuthGuard', () => {
  assert.throws(
    () => readCurrentUser(undefined, createContext({})),
    /CurrentUser requires AuthGuard/,
  );
});

test('RequestId exposes the request correlation id', () => {
  assert.equal(
    readRequestId(undefined, createContext({ requestId: 'request-one' })),
    'request-one',
  );
});

test('request boundary decorators expose only cookies and the raw Node connection', () => {
  const connection = { aborted: false, destroyed: false };
  const cookies = { access_token: 'access' };
  const context = createContext({ cookies, raw: connection });

  assert.equal(readRequestCookies(undefined, context), cookies);
  assert.equal(readRequestConnection(undefined, context), connection);
});

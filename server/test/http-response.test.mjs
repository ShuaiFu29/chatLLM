import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lastValueFrom, of } from 'rxjs';

const require = createRequire(import.meta.url);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { httpResponse } = require(path.join(
  serverRoot,
  'dist',
  'common',
  'http',
  'http-response.js',
));
const { HttpResponseInterceptor } = require(path.join(
  serverRoot,
  'dist',
  'common',
  'interceptors',
  'http-response.interceptor.js',
));

const createHarness = () => {
  const operations = [];
  const reply = {
    status: (value) => { operations.push(['status', value]); },
    header: (name, value) => { operations.push(['header', name, value]); },
    setCookie: (name, value, options) => {
      operations.push(['setCookie', name, value, options]);
    },
    clearCookie: (name, options) => { operations.push(['clearCookie', name, options]); },
  };
  const context = {
    switchToHttp: () => ({ getResponse: () => reply }),
  };
  return { context, operations };
};

test('HttpResponseInterceptor applies metadata and leaves serialization to Nest', async () => {
  const { context, operations } = createHarness();
  const result = httpResponse(
    { ok: true },
    {
      statusCode: 202,
      headers: { 'x-page': 3 },
      cookies: [
        { action: 'set', name: 'access', value: 'token', options: { httpOnly: true } },
        { action: 'clear', name: 'legacy', options: { path: '/' } },
      ],
    },
  );

  const body = await lastValueFrom(
    new HttpResponseInterceptor().intercept(context, { handle: () => of(result) }),
  );

  assert.deepEqual(body, { ok: true });
  assert.deepEqual(operations, [
    ['status', 202],
    ['header', 'x-page', 3],
    ['setCookie', 'access', 'token', { httpOnly: true }],
    ['clearCookie', 'legacy', { path: '/' }],
  ]);
});

test('HttpResponseInterceptor ignores ordinary controller values', async () => {
  const { context, operations } = createHarness();
  const value = { ok: true };
  const result = await lastValueFrom(
    new HttpResponseInterceptor().intercept(context, { handle: () => of(value) }),
  );

  assert.equal(result, value);
  assert.deepEqual(operations, []);
});

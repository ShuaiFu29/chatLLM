import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const { RequestMethod } = require('@nestjs/common');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { Test } = require('@nestjs/testing');
const { HttpExceptionFilter } = require(path.join(
  serverRoot,
  'dist',
  'common',
  'filters',
  'http-exception.filter.js',
));
const { registerHttpHooks } = require(path.join(
  serverRoot,
  'dist',
  'common',
  'http',
  'http-hooks.js',
));
const { OperationsController } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'operations',
  'operations.controller.js',
));

const operationalRoutes = [
  'health',
  'health/live',
  'health/ready',
  'health/queues',
  'metrics',
].map((routePath) => ({ path: routePath, method: RequestMethod.GET }));

let app;

before(async () => {
  const testingModule = await Test.createTestingModule({
    controllers: [OperationsController],
  }).compile();

  app = testingModule.createNestApplication(new FastifyAdapter());

  registerHttpHooks(app.getHttpAdapter().getInstance());
  app.setGlobalPrefix('api', { exclude: operationalRoutes });
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
});

after(async () => {
  await app?.close();
});

for (const [url, requestId] of [
  ['/health', 'nest-foundation-health'],
  ['/health/live', 'nest-foundation-live'],
]) {
  test(`GET ${url} exposes the operational health contract`, async () => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-request-id': requestId },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
    assert.equal(response.headers['x-request-id'], requestId);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(response.headers['permissions-policy'] || '', /microphone=\(\)/);
  });
}

test('unknown routes use the safe application 404 contract', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/not-a-real-route',
    headers: { 'x-request-id': 'nest-foundation-404' },
  });

  const body = response.json();

  assert.equal(response.statusCode, 404);
  assert.match(response.headers['content-type'] || '', /application\/json/);
  assert.equal(response.headers['x-request-id'], 'nest-foundation-404');
  assert.deepEqual(body, {
    error: 'Route not found',
    requestId: 'nest-foundation-404',
  });
  assert.equal('message' in body, false);
  assert.equal('statusCode' in body, false);
});

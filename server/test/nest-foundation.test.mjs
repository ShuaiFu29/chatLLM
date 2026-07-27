import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const { Body, Controller, Post } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { AppModule } = require(path.join(serverRoot, 'dist', 'app.module.js'));
const { RuntimeLifecycleService } = require(path.join(
  serverRoot,
  'dist',
  'infrastructure',
  'runtime-lifecycle.service.js',
));
const { createApplication } = require(path.join(serverRoot, 'dist', 'main.js'));
const requestLimits = require(path.join(serverRoot, 'dist', 'lib', 'requestLimits.js'));
const rateLimitRepository = require(path.join(
  serverRoot,
  'dist',
  'repositories',
  'rateLimits.js',
));

class RequestBodyProbeController {
  echo(body) {
    return { body };
  }
}

Controller('__test/request-limits')(RequestBodyProbeController);
Post('body')(
  RequestBodyProbeController.prototype,
  'echo',
  Object.getOwnPropertyDescriptor(RequestBodyProbeController.prototype, 'echo'),
);
Body()(RequestBodyProbeController.prototype, 'echo', 0);

const createJsonPayload = (totalBytes) => {
  const emptyPayload = JSON.stringify({ value: '' });
  const payload = JSON.stringify({
    value: 'x'.repeat(totalBytes - Buffer.byteLength(emptyPayload)),
  });
  assert.equal(Buffer.byteLength(payload), totalBytes);
  return payload;
};

let app;
let testingModule;
let originalConsumeRateLimitBucket;

before(async () => {
  originalConsumeRateLimitBucket = rateLimitRepository.consumeRateLimitBucket;
  rateLimitRepository.consumeRateLimitBucket = async () => ({
    count: 1,
    resetAt: Date.now() + 60000,
  });

  const lifecycleOverride = {
    onApplicationBootstrap: async () => undefined,
    beforeApplicationShutdown: async () => undefined,
    onApplicationShutdown: async () => undefined,
    startMaintenance: () => undefined,
  };
  testingModule = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [RequestBodyProbeController],
  })
    .overrideProvider(RuntimeLifecycleService)
    .useValue(lifecycleOverride)
    .compile();

  app = await createApplication({
    createNestApplication: (adapter, options) => (
      testingModule.createNestApplication(adapter, options)
    ),
  });
  await app.init();
});

after(async () => {
  await app?.close();
  if (originalConsumeRateLimitBucket) {
    rateLimitRepository.consumeRateLimitBucket = originalConsumeRateLimitBucket;
  }
});

for (const [url, requestId] of [
  ['/health', 'nest-foundation-health'],
  ['/health/live', 'nest-foundation-live'],
]) {
  test(`GET ${url} exposes the full application operational health contract`, async () => {
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

test('the full application listens on an ephemeral port and serves health', async () => {
  await app.listen(0, '127.0.0.1');
  const response = await fetch(`${await app.getUrl()}/health/live`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('Fastify router options preserve case-insensitive routes and trailing slashes', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/HEALTH/LIVE/',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});

test('the full application parses normal form-urlencoded bodies', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/__test/request-limits/body',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'name=Ada+Lovelace&team=platform',
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), {
    body: { name: 'Ada Lovelace', team: 'platform' },
  });
});

test('the full application rejects form-urlencoded bodies over 100 KiB', async () => {
  const payload = `value=${'x'.repeat(requestLimits.URLENCODED_REQUEST_LIMIT_BYTES)}`;
  assert.ok(Buffer.byteLength(payload) > requestLimits.URLENCODED_REQUEST_LIMIT_BYTES);

  const response = await app.inject({
    method: 'POST',
    url: '/api/__test/request-limits/body',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload,
  });

  assert.equal(response.statusCode, 413);
});

test('the full application accepts JSON bodies at the 1 MiB boundary', async () => {
  const payload = createJsonPayload(requestLimits.JSON_REQUEST_LIMIT_BYTES);
  const response = await app.inject({
    method: 'POST',
    url: '/api/__test/request-limits/body',
    headers: { 'content-type': 'application/json' },
    payload,
  });

  assert.equal(response.statusCode, 201);
  assert.equal(
    response.json().body.value.length,
    requestLimits.JSON_REQUEST_LIMIT_BYTES - Buffer.byteLength(JSON.stringify({ value: '' })),
  );
});

test('the full application rejects JSON bodies over 1 MiB', async () => {
  const payload = createJsonPayload(requestLimits.JSON_REQUEST_LIMIT_BYTES + 1);
  const response = await app.inject({
    method: 'POST',
    url: '/api/__test/request-limits/body',
    headers: { 'content-type': 'application/json' },
    payload,
  });

  assert.equal(response.statusCode, 413);
});

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

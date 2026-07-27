import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'minioadmin',
  S3_SECRET_KEY: 'minioadmin',
  JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
  DEEPSEEK_API_KEY: 'sk-test',
  METRICS_TOKEN: 'test-metrics-token',
  CORS_ALLOWED_ORIGINS: 'http://allowed.example',
});

let app;
let fastify;

before(async () => {
  const { Controller, Post } = require('@nestjs/common');
  const { FastifyAdapter } = require('@nestjs/platform-fastify');
  const { Test } = require('@nestjs/testing');
  const cors = require('@fastify/cors');
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
  const { JSON_REQUEST_LIMIT_BYTES } = require(path.join(
    serverRoot,
    'dist',
    'lib',
    'requestLimits.js',
  ));
  const { OperationsController } = require(path.join(
    serverRoot,
    'dist',
    'modules',
    'operations',
    'operations.controller.js',
  ));

  class BodyProbeController {
    accept() {
      return { accepted: true };
    }
  }
  Controller('test')(BodyProbeController);
  Post('body')(
    BodyProbeController.prototype,
    'accept',
    Object.getOwnPropertyDescriptor(BodyProbeController.prototype, 'accept'),
  );

  const testingModule = await Test.createTestingModule({
    controllers: [OperationsController, BodyProbeController],
  }).compile();
  app = testingModule.createNestApplication(new FastifyAdapter({
    bodyLimit: JSON_REQUEST_LIMIT_BYTES,
  }));
  fastify = app.getHttpAdapter().getInstance();

  registerHttpHooks(fastify);
  await app.register(cors, {
    credentials: true,
    exposedHeaders: [
      'x-chatllm-has-more',
      'x-chatllm-next-cursor',
      'x-chatllm-page-limit',
    ],
    origin: (origin, callback) => {
      if (!origin || origin === 'http://allowed.example') {
        callback(null, true);
        return;
      }
      const error = new Error('Not allowed by CORS');
      error.statusCode = 403;
      callback(error, false);
    },
  });
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await fastify.ready();
});

after(async () => {
  await app?.close();
});

test('live health responses include security headers and request ids', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/health/live',
    headers: {
      'x-request-id': 'test-request-1',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-request-id'], 'test-request-1');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['permissions-policy'] || '', /microphone=\(\)/);
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.deepEqual(response.json(), { status: 'ok' });
});

test('request completion logs exclude query strings and reject unsafe request ids', async () => {
  const originalConsoleInfo = console.info;
  const infoLogs = [];
  console.info = (message) => {
    infoLogs.push(message);
  };

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live?access_token=query-secret-value',
      headers: {
        'x-request-id': 'unsafe request id with spaces and secret-value',
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.statusCode, 200);
    assert.notEqual(
      response.headers['x-request-id'],
      'unsafe request id with spaces and secret-value',
    );
    assert.equal(infoLogs.length, 1);

    const logEntry = JSON.parse(infoLogs[0]);
    assert.equal(logEntry.path, '/health/live');
    assert.doesNotMatch(infoLogs[0], /query-secret-value|access_token|secret-value/);
  } finally {
    console.info = originalConsoleInfo;
  }
});

test('unknown API routes return structured JSON 404 responses', async () => {
  const originalConsoleError = console.error;
  const originalConsoleInfo = console.info;
  const errorLogs = [];
  const infoLogs = [];
  console.error = (message) => {
    errorLogs.push(message);
  };
  console.info = (message) => {
    infoLogs.push(message);
  };

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/not-a-real-route/secret-path-value?access_token=query-secret-value',
      headers: {
        'x-request-id': 'test-request-404',
      },
    });

    assert.equal(response.statusCode, 404);
    assert.match(response.headers['content-type'] || '', /application\/json/);
    assert.deepEqual(response.json(), {
      error: 'Route not found',
      requestId: 'test-request-404',
    });

    assert.equal(errorLogs.length, 1);
    const logEntry = JSON.parse(errorLogs[0]);
    assert.equal(logEntry.status_code, 404);
    assert.equal('stack' in logEntry, false);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(infoLogs.length, 1);
    assert.equal(JSON.parse(infoLogs[0]).path, 'unmatched');
    assert.doesNotMatch(infoLogs[0], /secret-path-value|query-secret-value|access_token/);
  } finally {
    console.error = originalConsoleError;
    console.info = originalConsoleInfo;
  }
});

test('CORS allows configured origins, exposes pagination headers, and rejects other origins', async () => {
  const allowed = await app.inject({
    method: 'GET',
    url: '/health/live',
    headers: { origin: 'http://allowed.example' },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://allowed.example');
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  assert.match(
    allowed.headers['access-control-expose-headers'] || '',
    /x-chatllm-next-cursor/i,
  );

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const rejected = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'http://blocked.example' },
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.json().error, 'Origin is not allowed');
  } finally {
    console.error = originalConsoleError;
  }
});

test('JSON request bodies remain bounded by the configured Fastify limit', async () => {
  const { JSON_REQUEST_LIMIT_BYTES } = require(path.join(
    serverRoot,
    'dist',
    'lib',
    'requestLimits.js',
  ));
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/test/body',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'x'.repeat(JSON_REQUEST_LIMIT_BYTES) }),
    });
    assert.equal(response.statusCode, 413);
    assert.deepEqual(response.json(), {
      error: 'Request body too large',
      requestId: response.headers['x-request-id'],
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('metrics endpoint fails closed and serves Prometheus output only with its token', async () => {
  const unauthorized = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(unauthorized.json(), { error: 'Unauthorized' });

  const authorized = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: 'Bearer test-metrics-token' },
  });
  assert.equal(authorized.statusCode, 200);
  assert.match(authorized.headers['content-type'] || '', /text\/plain/);
  assert.match(authorized.body, /chatllm_http_requests_total/);
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, test } from 'node:test';
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
});

const { app } = require(path.join(serverRoot, 'dist', 'index.js'));
const { closeDatabasePool } = require(path.join(serverRoot, 'dist', 'lib', 'db.js'));

after(async () => {
  await closeDatabasePool();
});

const listen = () => new Promise((resolve) => {
  const server = createServer(app);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
});

const request = (server, pathname, options = {}) => {
  const address = server.address();
  return fetch(`http://127.0.0.1:${address.port}${pathname}`, options);
};

test('live health responses include security headers and request ids', async () => {
  const server = await listen();

  try {
    const response = await request(server, '/health/live', {
      headers: {
        'x-request-id': 'test-request-1',
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'test-request-1');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('permissions-policy') || '', /microphone=\(\)/);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await close(server);
  }
});

test('request completion logs exclude query strings and reject unsafe request ids', async () => {
  const server = await listen();
  const originalConsoleInfo = console.info;
  const infoLogs = [];
  console.info = (message) => {
    infoLogs.push(message);
  };

  try {
    const response = await request(server, '/health/live?access_token=query-secret-value', {
      headers: {
        'x-request-id': 'unsafe request id with spaces and secret-value',
      },
    });
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get('x-request-id'), 'unsafe request id with spaces and secret-value');
    assert.equal(infoLogs.length, 1);

    const logEntry = JSON.parse(infoLogs[0]);
    assert.equal(logEntry.path, '/health/live');
    assert.doesNotMatch(infoLogs[0], /query-secret-value|access_token|secret-value/);
  } finally {
    console.info = originalConsoleInfo;
    await close(server);
  }
});

test('unknown API routes return structured JSON 404 responses', async () => {
  const server = await listen();
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
    const response = await request(server, '/api/not-a-real-route/secret-path-value?access_token=query-secret-value', {
      headers: {
        'x-request-id': 'test-request-404',
      },
    });

    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await response.json(), {
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
    await close(server);
  }
});

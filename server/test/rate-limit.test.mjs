import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
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

const { createRateLimit } = require(path.join(serverRoot, 'dist', 'middleware', 'rateLimit.js'));
const { generateAccessToken } = require(path.join(serverRoot, 'dist', 'lib', 'jwt.js'));

const createUser = (id) => ({
  id,
  github_id: Math.floor(Math.random() * 1000000),
  username: id,
  avatar_url: '',
  display_name: id,
});

const createMockResponse = () => ({
  locals: { requestId: 'rate-limit-test' },
  statusCode: 200,
  headers: new Map(),
  body: undefined,
  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), String(value));
  },
  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const invokeMiddleware = async (middleware, req) => {
  const res = createMockResponse();
  let nextCalled = false;

  await middleware(req, res, () => {
    nextCalled = true;
  });

  return { res, nextCalled };
};

test('rate limiter scopes authenticated users separately before route auth runs', async () => {
  const userAToken = generateAccessToken(createUser('user-a'));
  const userBToken = generateAccessToken(createUser('user-b'));
  const limiter = createRateLimit({
    keyPrefix: `rate-limit-test-${Date.now()}`,
    windowMs: 60000,
    max: 1,
  });

  const first = await invokeMiddleware(limiter, {
    ip: '127.0.0.1',
    cookies: { access_token: userAToken },
  });
  const second = await invokeMiddleware(limiter, {
    ip: '127.0.0.1',
    cookies: { access_token: userBToken },
  });

  assert.equal(first.nextCalled, true);
  assert.equal(first.res.statusCode, 200);
  assert.equal(second.nextCalled, true);
  assert.equal(second.res.statusCode, 200);
});

test('rate limiter evicts oldest active buckets when cardinality exceeds cap', async () => {
  const limiter = createRateLimit({
    keyPrefix: `rate-limit-cardinality-test-${Date.now()}`,
    windowMs: 60000,
    max: 1,
  });

  for (let index = 0; index < 10005; index += 1) {
    const result = await invokeMiddleware(limiter, {
      ip: `10.0.${Math.floor(index / 255)}.${index % 255}`,
      cookies: {},
    });

    assert.equal(result.nextCalled, true);
    assert.equal(result.res.statusCode, 200);
  }

  const oldestBucketResult = await invokeMiddleware(limiter, {
    ip: '10.0.0.0',
    cookies: {},
  });

  assert.equal(oldestBucketResult.nextCalled, true);
  assert.equal(oldestBucketResult.res.statusCode, 200);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');

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

const createSharedConsumer = () => {
  const buckets = new Map();
  const calls = [];

  return {
    calls,
    consume: async ({ bucketKey, windowMs }) => {
      calls.push({ bucketKey, windowMs });
      const now = Date.now();
      const current = buckets.get(bucketKey);
      const bucket = !current || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
      buckets.set(bucketKey, bucket);
      return bucket;
    },
  };
};

test('rate limiter scopes authenticated users separately before route auth runs', async () => {
  const userAToken = generateAccessToken(createUser('user-a'));
  const userBToken = generateAccessToken(createUser('user-b'));
  const shared = createSharedConsumer();
  const limiter = createRateLimit({
    keyPrefix: `rate-limit-test-${Date.now()}`,
    windowMs: 60000,
    max: 1,
  }, shared.consume);

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
  assert.equal(shared.calls.length, 2);
  assert.notEqual(shared.calls[0].bucketKey, shared.calls[1].bucketKey);
  assert.doesNotMatch(JSON.stringify(shared.calls), /user-a|user-b|127\.0\.0\.1/);
  assert.match(shared.calls[0].bucketKey, /^[^:]+:[a-f0-9]{64}$/);
});

test('rate limiter can skip read-only routes while still limiting mutations', async () => {
  const shared = createSharedConsumer();
  const limiter = createRateLimit({
    keyPrefix: `rate-limit-skip-test-${Date.now()}`,
    windowMs: 60000,
    max: 1,
    skip: (req) => req.method === 'GET',
  }, shared.consume);

  const firstRead = await invokeMiddleware(limiter, {
    method: 'GET',
    ip: '127.0.0.1',
    cookies: {},
  });
  const secondRead = await invokeMiddleware(limiter, {
    method: 'GET',
    ip: '127.0.0.1',
    cookies: {},
  });
  const firstWrite = await invokeMiddleware(limiter, {
    method: 'POST',
    ip: '127.0.0.1',
    cookies: {},
  });
  const secondWrite = await invokeMiddleware(limiter, {
    method: 'POST',
    ip: '127.0.0.1',
    cookies: {},
  });

  assert.equal(firstRead.nextCalled, true);
  assert.equal(firstRead.res.headers.has('x-ratelimit-limit'), false);
  assert.equal(secondRead.nextCalled, true);
  assert.equal(secondRead.res.headers.has('x-ratelimit-limit'), false);
  assert.equal(firstWrite.nextCalled, true);
  assert.equal(firstWrite.res.statusCode, 200);
  assert.equal(secondWrite.nextCalled, false);
  assert.equal(secondWrite.res.statusCode, 429);
  assert.equal(shared.calls.length, 2);
});

test('independent limiter instances consume one shared bucket', async () => {
  const shared = createSharedConsumer();
  const options = {
    keyPrefix: `rate-limit-shared-test-${Date.now()}`,
    windowMs: 60000,
    max: 1,
  };
  const limiterA = createRateLimit(options, shared.consume);
  const limiterB = createRateLimit(options, shared.consume);
  const request = {
    ip: '10.0.0.1',
    cookies: {},
  };

  const first = await invokeMiddleware(limiterA, request);
  const second = await invokeMiddleware(limiterB, request);

  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, false);
  assert.equal(second.res.statusCode, 429);
  assert.equal(shared.calls.length, 2);
  assert.equal(shared.calls[0].bucketKey, shared.calls[1].bucketKey);
});

test('rate limiter fails closed without reflecting repository errors', async () => {
  const secret = 'postgres://user:secret-password@database.internal/chatllm';
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logs.push(args);
  const limiter = createRateLimit({
    keyPrefix: `rate-limit-failure-test-${Date.now()}`,
    windowMs: 60000,
    max: 1,
  }, async () => {
    throw new Error(secret);
  });

  try {
    const result = await invokeMiddleware(limiter, {
      ip: '127.0.0.1',
      cookies: { access_token: generateAccessToken(createUser('sensitive-user')) },
    });

    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 503);
    assert.deepEqual(result.res.body, {
      error: 'Rate limit service unavailable',
      requestId: 'rate-limit-test',
    });
    assert.equal(result.res.headers.get('retry-after'), '1');
    assert.doesNotMatch(JSON.stringify(logs), /secret-password|database\.internal/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('rate limit repository consumes one atomic Redis fixed-window script', async () => {
  const repository = require(path.join(serverRoot, 'dist', 'repositories', 'rateLimits.js'));
  const calls = [];
  const redis = {
    async eval(...args) {
      calls.push(args);
      return [2, 45000];
    },
  };

  const before = Date.now();
  const consumed = await repository.consumeRateLimitBucket({
    bucketKey: `global:${'a'.repeat(64)}`,
    windowMs: 60000,
  }, redis);

  assert.equal(consumed.count, 2);
  assert.ok(consumed.resetAt >= before + 45000);
  assert.ok(consumed.resetAt <= Date.now() + 45000);
  assert.equal(calls.length, 1);
  const [script, keyCount, key, windowMs] = calls[0];
  assert.equal(keyCount, 1);
  assert.equal(key, `chatllm:rate-limit:global:${'a'.repeat(64)}`);
  assert.equal(windowMs, 60000);
  assert.match(script, /redis\.call\('INCR', KEYS\[1\]\)/);
  assert.match(script, /redis\.call\('PEXPIRE', KEYS\[1\], ARGV\[1\]\)/);
  assert.match(script, /redis\.call\('PTTL', KEYS\[1\]\)/);
});

test('Redis rate limiting preserves principal scoping and fails closed', () => {
  const middlewareSource = readSource('src/middleware/rateLimit.ts');
  const indexSource = readSource('src/index.ts');
  assert.match(middlewareSource, /consumeRateLimitBucket/);
  assert.match(middlewareSource, /isIP/);
  assert.doesNotMatch(middlewareSource, /new Map|MAX_RATE_LIMIT_BUCKETS|pruneOldestBuckets/);
  assert.match(indexSource, /app\.set\('trust proxy', serverEnv\.TRUST_PROXY_HOPS\)/);
  assert.doesNotMatch(indexSource, /app\.set\('trust proxy', 1\)/);

  const cookieParserIndex = indexSource.indexOf('app.use(cookieParser())');
  const globalLimiterIndex = indexSource.indexOf("keyPrefix: 'global'");
  assert.ok(cookieParserIndex >= 0 && cookieParserIndex < globalLimiterIndex);
});

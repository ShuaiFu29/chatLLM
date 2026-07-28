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
  RATE_LIMIT_WINDOW_MS: '60000',
});

const rateLimitModule = require(path.join(
  serverRoot,
  'dist',
  'common',
  'guards',
  'rate-limit.guard.js',
));
const rateLimitRepository = require(path.join(serverRoot, 'dist', 'repositories', 'rateLimits.js'));
const { Reflector } = require(path.join(serverRoot, 'node_modules', '@nestjs', 'core'));
const { generateAccessToken } = require(path.join(serverRoot, 'dist', 'lib', 'jwt.js'));
const {
  consumeRequestRateLimit,
  RateLimitGuard,
  RateLimitScope,
} = rateLimitModule;

const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');

const createUser = (id) => ({
  id,
  github_id: String(Math.floor(Math.random() * 1000000) + 1),
  username: id,
  avatar_url: '',
  display_name: id,
});

const createMockReply = () => ({
  headers: new Map(),
  header(name, value) {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  },
});

const createExecutionContext = (request, reply, handler, controller) => ({
  getHandler: () => handler,
  getClass: () => controller,
  switchToHttp: () => ({
    getRequest: () => request,
    getResponse: () => reply,
  }),
});

const createScopedGuard = (options) => {
  const handler = function rateLimitedHandler() {};
  class TestController {}
  RateLimitScope(options)(handler);
  return {
    guard: new RateLimitGuard(new Reflector()),
    context: (request, reply) => createExecutionContext(request, reply, handler, TestController),
  };
};

const withConsumer = async (consumer, callback) => {
  const originalConsumer = rateLimitRepository.consumeRateLimitBucket;
  rateLimitRepository.consumeRateLimitBucket = consumer;
  try {
    return await callback();
  } finally {
    rateLimitRepository.consumeRateLimitBucket = originalConsumer;
  }
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

test('rate limiter scopes authenticated users separately before AuthGuard runs', async () => {
  const userAToken = generateAccessToken(createUser('user-a'));
  const userBToken = generateAccessToken(createUser('user-b'));
  const shared = createSharedConsumer();
  const options = { keyPrefix: `rate-limit-test-${Date.now()}`, max: 1 };

  await withConsumer(shared.consume, async () => {
    const first = await consumeRequestRateLimit({
      ip: '127.0.0.1',
      cookies: { access_token: userAToken },
      requestId: 'rate-limit-a',
    }, createMockReply(), options);
    const second = await consumeRequestRateLimit({
      ip: '127.0.0.1',
      cookies: { access_token: userBToken },
      requestId: 'rate-limit-b',
    }, createMockReply(), options);

    assert.deepEqual(first, { allowed: true });
    assert.deepEqual(second, { allowed: true });
  });

  assert.equal(shared.calls.length, 2);
  assert.notEqual(shared.calls[0].bucketKey, shared.calls[1].bucketKey);
  assert.doesNotMatch(JSON.stringify(shared.calls), /user-a|user-b|127\.0\.0\.1/);
  assert.match(shared.calls[0].bucketKey, /^[^:]+:[a-f0-9]{64}$/);
});

test('RateLimitGuard skips configured read methods while still limiting mutations', async () => {
  const shared = createSharedConsumer();
  const scope = createScopedGuard({
    keyPrefix: `rate-limit-skip-test-${Date.now()}`,
    max: 1,
    skipMethods: ['GET'],
  });

  await withConsumer(shared.consume, async () => {
    const readReply = createMockReply();
    assert.equal(await scope.guard.canActivate(scope.context({
      method: 'GET',
      ip: '127.0.0.1',
      cookies: {},
    }, readReply)), true);
    assert.equal(readReply.headers.has('x-ratelimit-limit'), false);

    const firstWriteReply = createMockReply();
    assert.equal(await scope.guard.canActivate(scope.context({
      method: 'POST',
      ip: '127.0.0.1',
      cookies: {},
    }, firstWriteReply)), true);
    assert.equal(firstWriteReply.headers.get('x-ratelimit-limit'), '1');

    const secondWriteReply = createMockReply();
    await assert.rejects(
      scope.guard.canActivate(scope.context({
        method: 'POST',
        ip: '127.0.0.1',
        cookies: {},
        requestId: 'rate-limit-test',
      }, secondWriteReply)),
      (error) => error.getStatus() === 429
        && error.getResponse().error === 'Too many requests',
    );
    assert.equal(secondWriteReply.headers.get('x-ratelimit-limit'), '1');
    assert.equal(secondWriteReply.headers.get('x-ratelimit-remaining'), '0');
    assert.match(secondWriteReply.headers.get('x-ratelimit-reset'), /^\d+$/);
    assert.match(secondWriteReply.headers.get('retry-after'), /^\d+$/);
  });

  assert.equal(shared.calls.length, 2);
});

test('independent RateLimitGuard instances consume one shared IP bucket', async () => {
  const shared = createSharedConsumer();
  const options = { keyPrefix: `rate-limit-shared-test-${Date.now()}`, max: 1 };
  const scopeA = createScopedGuard(options);
  const scopeB = createScopedGuard(options);
  const request = { method: 'POST', ip: '10.0.0.1', cookies: {} };

  await withConsumer(shared.consume, async () => {
    assert.equal(
      await scopeA.guard.canActivate(scopeA.context(request, createMockReply())),
      true,
    );
    await assert.rejects(
      scopeB.guard.canActivate(scopeB.context(request, createMockReply())),
      (error) => error.getStatus() === 429,
    );
  });

  assert.equal(shared.calls.length, 2);
  assert.equal(shared.calls[0].bucketKey, shared.calls[1].bucketKey);
  assert.doesNotMatch(shared.calls[0].bucketKey, /10\.0\.0\.1/);
});

test('credential routes also share a private normalized identity bucket across IPs', async () => {
  const shared = createSharedConsumer();
  const scope = createScopedGuard({
    keyPrefix: `auth-identity-test-${Date.now()}`,
    max: 1,
    identityBodyField: 'email',
    message: 'Too many login attempts',
  });

  await withConsumer(shared.consume, async () => {
    assert.equal(await scope.guard.canActivate(scope.context({
      method: 'POST',
      ip: '10.0.0.1',
      cookies: {},
      body: { email: '  ADA@Example.COM  ' },
    }, createMockReply())), true);

    await assert.rejects(
      scope.guard.canActivate(scope.context({
        method: 'POST',
        ip: '10.0.0.2',
        cookies: {},
        body: { email: 'ada@example.com' },
      }, createMockReply())),
      (error) => error.getStatus() === 429
        && error.getResponse().error === 'Too many login attempts',
    );
  });

  assert.equal(shared.calls.length, 4);
  assert.notEqual(shared.calls[0].bucketKey, shared.calls[2].bucketKey);
  assert.equal(shared.calls[1].bucketKey, shared.calls[3].bucketKey);
  assert.match(shared.calls[1].bucketKey, /:identity:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(shared.calls), /ada@example\.com/i);
});

test('RateLimitGuard fails closed without reflecting repository errors', async () => {
  const secret = 'postgres://user:secret-password@database.internal/chatllm';
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logs.push(args);
  const scope = createScopedGuard({
    keyPrefix: `rate-limit-failure-test-${Date.now()}`,
    max: 1,
  });
  const reply = createMockReply();

  try {
    await withConsumer(async () => {
      throw new Error(secret);
    }, async () => {
      await assert.rejects(
        scope.guard.canActivate(scope.context({
          method: 'POST',
          ip: '127.0.0.1',
          cookies: { access_token: generateAccessToken(createUser('sensitive-user')) },
          requestId: 'rate-limit-test',
        }, reply)),
        (error) => {
          assert.equal(error.getStatus(), 503);
          assert.deepEqual(error.getResponse(), {
            error: 'Rate limit service unavailable',
            requestId: 'rate-limit-test',
          });
          return true;
        },
      );
    });

    assert.equal(reply.headers.get('retry-after'), '1');
    assert.doesNotMatch(JSON.stringify(logs), /secret-password|database\.internal/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('rate limit repository consumes one atomic Redis fixed-window script', async () => {
  const calls = [];
  const redis = {
    async eval(...args) {
      calls.push(args);
      return [2, 45000];
    },
  };

  const before = Date.now();
  const consumed = await rateLimitRepository.consumeRateLimitBucket({
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

test('Nest rate limiting preserves Redis principal scoping without in-memory fallback', () => {
  const guardSource = readSource('src/common/guards/rate-limit.guard.ts');

  assert.match(guardSource, /consumeRateLimitBucket/);
  assert.match(guardSource, /isIP/);
  assert.match(guardSource, /verifyAccessToken/);
  assert.match(guardSource, /reply\.header\('X-RateLimit-Limit'/);
  assert.match(guardSource, /throw new HttpException/);
  assert.doesNotMatch(guardSource, /new Map|MAX_RATE_LIMIT_BUCKETS|pruneOldestBuckets/);
});

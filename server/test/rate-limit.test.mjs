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

test('rate limit repository uses one atomic upsert and bounded expiry cleanup', async () => {
  const repository = require(path.join(serverRoot, 'dist', 'repositories', 'rateLimits.js'));
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/insert into rate_limit_buckets/i.test(sql)) {
      return {
        rows: [{ request_count: '2', expires_at: '2026-07-12T12:00:00.000Z' }],
        rowCount: 1,
      };
    }
    if (/delete from rate_limit_buckets/i.test(sql)) {
      return { rows: [], rowCount: 3 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  const consumed = await repository.consumeRateLimitBucket({
    bucketKey: `global:${'a'.repeat(64)}`,
    windowMs: 60000,
  }, query);
  const deleted = await repository.deleteExpiredRateLimitBuckets(50, query);

  assert.deepEqual(consumed, {
    count: 2,
    resetAt: Date.parse('2026-07-12T12:00:00.000Z'),
  });
  assert.equal(deleted, 3);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /insert into rate_limit_buckets/i);
  assert.match(calls[0].sql, /on conflict \(bucket_key\) do update/i);
  assert.match(calls[0].sql, /request_count = case/i);
  assert.match(calls[0].sql, /expires_at <= excluded\.window_started_at/i);
  assert.match(calls[0].sql, /returning request_count, expires_at/i);
  assert.deepEqual(calls[0].params, [`global:${'a'.repeat(64)}`, 60000]);
  assert.match(calls[1].sql, /limit \$1/i);
  assert.match(calls[1].sql, /delete from rate_limit_buckets/i);
  assert.match(
    calls[1].sql,
    /where bucket\.bucket_key = expired\.bucket_key\s+and bucket\.expires_at <= clock_timestamp\(\)/i,
    'cleanup must recheck expiry after waiting on a concurrently refreshed bucket',
  );
  assert.deepEqual(calls[1].params, [50]);
});

test('security migration and maintenance define durable bounded rate-limit buckets', () => {
  const migrationSource = readSource('migrations/0025_security_sessions_rate_limits.sql');
  const middlewareSource = readSource('src/middleware/rateLimit.ts');
  const indexSource = readSource('src/index.ts');
  const maintenanceSource = readSource('src/services/maintenance.ts');

  assert.match(migrationSource, /create table if not exists rate_limit_buckets/i);
  assert.match(migrationSource, /bucket_key text primary key/i);
  assert.match(migrationSource, /window_started_at timestamptz not null/i);
  assert.match(migrationSource, /request_count integer not null/i);
  assert.match(migrationSource, /expires_at timestamptz not null/i);
  assert.match(migrationSource, /rate_limit_buckets_expires_at_idx/i);
  assert.match(middlewareSource, /consumeRateLimitBucket/);
  assert.match(middlewareSource, /isIP/);
  assert.doesNotMatch(middlewareSource, /new Map|MAX_RATE_LIMIT_BUCKETS|pruneOldestBuckets/);
  assert.match(indexSource, /app\.set\('trust proxy', serverEnv\.TRUST_PROXY_HOPS\)/);
  assert.doesNotMatch(indexSource, /app\.set\('trust proxy', 1\)/);
  assert.match(maintenanceSource, /deleteExpiredRateLimitBuckets/);

  const cookieParserIndex = indexSource.indexOf('app.use(cookieParser())');
  const globalLimiterIndex = indexSource.indexOf("keyPrefix: 'global'");
  assert.ok(cookieParserIndex >= 0 && cookieParserIndex < globalLimiterIndex);
});

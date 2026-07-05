import { RequestHandler } from 'express';
import { verifyAccessToken } from '../lib/jwt';
import { metrics } from '../lib/metrics';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const MAX_RATE_LIMIT_BUCKETS = 10000;
const buckets = new Map<string, RateLimitBucket>();

const getAuthenticatedUserId = (req: Parameters<RequestHandler>[0]) => {
  if (req.user?.id) return req.user.id;

  const accessToken = typeof req.cookies?.access_token === 'string'
    ? req.cookies.access_token
    : undefined;
  if (!accessToken) return null;

  return verifyAccessToken(accessToken)?.id ?? null;
};

const getClientKey = (req: Parameters<RequestHandler>[0], keyPrefix: string) => {
  const authenticatedUserId = getAuthenticatedUserId(req);
  return `${keyPrefix}:${authenticatedUserId || req.ip || 'unknown'}`;
};

const pruneExpiredBuckets = (now: number) => {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
};

const pruneOldestBuckets = () => {
  while (buckets.size > MAX_RATE_LIMIT_BUCKETS) {
    const oldestKey = buckets.keys().next().value;
    if (!oldestKey) return;
    buckets.delete(oldestKey);
  }
};

export const createRateLimit = (options: RateLimitOptions): RequestHandler => {
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size >= MAX_RATE_LIMIT_BUCKETS) pruneExpiredBuckets(now);

    const key = getClientKey(req, options.keyPrefix);
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + options.windowMs }
      : current;

    bucket.count += 1;
    buckets.set(key, bucket);
    pruneOldestBuckets();

    res.setHeader('X-RateLimit-Limit', String(options.max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(options.max - bucket.count, 0)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.max) {
      const retryAfterSeconds = Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      metrics.recordRateLimitRejected(options.keyPrefix);
      return res.status(429).json({
        error: options.message || 'Too many requests',
        requestId: res.locals.requestId,
      });
    }

    return next();
  };
};

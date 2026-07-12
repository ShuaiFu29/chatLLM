import { createHash } from 'crypto';
import { RequestHandler } from 'express';
import { isIP } from 'net';
import { verifyAccessToken } from '../lib/jwt';
import { metrics } from '../lib/metrics';
import { toSafeError } from '../lib/safeError';
import {
  consumeRateLimitBucket,
  RateLimitBucketConsumer,
} from '../repositories/rateLimits';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
  skip?: (req: Parameters<RequestHandler>[0]) => boolean;
}

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
  const rawIp = typeof req.ip === 'string' ? req.ip.trim() : '';
  const clientIp = isIP(rawIp) ? rawIp : 'unknown';
  const principal = authenticatedUserId
    ? `user:${authenticatedUserId}`
    : `ip:${clientIp}`;
  const digest = createHash('sha256').update(principal, 'utf8').digest('hex');
  return `${keyPrefix}:${digest}`;
};

export const createRateLimit = (
  options: RateLimitOptions,
  consumeBucket: RateLimitBucketConsumer = consumeRateLimitBucket
): RequestHandler => {
  return async (req, res, next) => {
    if (options.skip?.(req)) return next();

    try {
      const bucket = await consumeBucket({
        bucketKey: getClientKey(req, options.keyPrefix),
        windowMs: options.windowMs,
      });
      const now = Date.now();

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
    } catch (error) {
      console.error('[RateLimit] Shared store unavailable:', toSafeError(error, res.locals.requestId));
      res.setHeader('Retry-After', '1');
      return res.status(503).json({
        error: 'Rate limit service unavailable',
        requestId: res.locals.requestId,
      });
    }
  };
};

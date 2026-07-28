import { createHash, createHmac } from 'crypto';
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isIP } from 'net';
import { serverEnv } from '../../lib/env';
import { verifyAccessToken } from '../../lib/jwt';
import { metrics } from '../../lib/metrics';
import { toSafeError } from '../../lib/safeError';
import { consumeRateLimitBucket } from '../../repositories/rateLimits';
import { AppReply, AppRequest } from '../http/app-request';

const SKIP_RATE_LIMIT = Symbol('chatllm.skip-rate-limit');
const RATE_LIMIT_SCOPE = Symbol('chatllm.rate-limit-scope');

export interface RateLimitScopeOptions {
  keyPrefix: string;
  max: number;
  identityBodyField?: string;
  message?: string;
  skipMethods?: readonly string[];
}

export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
export const RateLimitScope = (options: RateLimitScopeOptions) => (
  SetMetadata(RATE_LIMIT_SCOPE, options)
);

const getAuthenticatedUserId = (request: AppRequest) => {
  if (request.user?.id) return request.user.id;
  const accessToken = request.cookies?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  return verifyAccessToken(accessToken)?.id ?? null;
};

const getBucketKey = (request: AppRequest, keyPrefix: string) => {
  const userId = getAuthenticatedUserId(request);
  const rawIp = typeof request.ip === 'string' ? request.ip.trim() : '';
  const clientIp = isIP(rawIp) ? rawIp : 'unknown';
  const principal = userId ? `user:${userId}` : `ip:${clientIp}`;
  const digest = createHash('sha256').update(principal, 'utf8').digest('hex');
  return `${keyPrefix}:${digest}`;
};

const getIdentityBucketKey = (
  request: AppRequest,
  options: RateLimitScopeOptions,
) => {
  const field = options.identityBodyField;
  if (!field) return null;
  const rawIdentity = request.body?.[field];
  if (typeof rawIdentity !== 'string') return null;
  const identity = rawIdentity.trim().toLowerCase().slice(0, 320);
  if (!identity) return null;

  const digest = createHmac('sha256', serverEnv.JWT_SECRET)
    .update(`${field}:${identity}`, 'utf8')
    .digest('hex');
  return `${options.keyPrefix}:identity:${digest}`;
};

export type RateLimitDecision = {
  allowed: true;
} | {
  allowed: false;
  statusCode: 429;
  body: {
    error: string;
    requestId?: string;
  };
};

const consumeBucketRateLimit = async (
  bucketKey: string,
  requestId: string | undefined,
  reply: AppReply,
  options: RateLimitScopeOptions,
): Promise<RateLimitDecision> => {
  const bucket = await consumeRateLimitBucket({
    bucketKey,
    windowMs: serverEnv.RATE_LIMIT_WINDOW_MS,
  });
  const now = Date.now();

  reply.header('X-RateLimit-Limit', String(options.max));
  reply.header('X-RateLimit-Remaining', String(Math.max(options.max - bucket.count, 0)));
  reply.header('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count <= options.max) return { allowed: true };

  const retryAfterSeconds = Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1);
  reply.header('Retry-After', String(retryAfterSeconds));
  metrics.recordRateLimitRejected(options.keyPrefix);
  return {
    allowed: false,
    statusCode: 429,
    body: {
      error: options.message || 'Too many requests',
      requestId,
    },
  };
};

export const consumeRequestRateLimit = async (
  request: AppRequest,
  reply: AppReply,
  options: RateLimitScopeOptions,
): Promise<RateLimitDecision> => consumeBucketRateLimit(
  getBucketKey(request, options.keyPrefix),
  request.requestId,
  reply,
  options,
);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext) {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const scope = this.reflector.getAllAndOverride<RateLimitScopeOptions>(RATE_LIMIT_SCOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const http = context.switchToHttp();
    const request = http.getRequest<AppRequest>();
    const reply = http.getResponse<AppReply>();

    if (!scope || scope.skipMethods?.includes(request.method)) return true;

    try {
      const decision = await consumeRequestRateLimit(request, reply, scope);
      if (!decision.allowed) {
        throw new HttpException(decision.body, decision.statusCode);
      }

      const identityBucketKey = getIdentityBucketKey(request, scope);
      if (identityBucketKey) {
        const identityDecision = await consumeBucketRateLimit(
          identityBucketKey,
          request.requestId,
          reply,
          scope,
        );
        if (!identityDecision.allowed) {
          throw new HttpException(identityDecision.body, identityDecision.statusCode);
        }
      }
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;

      console.error(
        '[RateLimit] Shared store unavailable:',
        toSafeError(error, request.requestId),
      );
      reply.header('Retry-After', '1');
      throw new HttpException({
        error: 'Rate limit service unavailable',
        requestId: request.requestId,
      }, 503);
    }
  }
}

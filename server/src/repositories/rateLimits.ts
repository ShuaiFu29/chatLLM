import { serverEnv } from '../lib/env';
import { getRedisClient } from '../lib/redis';

export interface ConsumeRateLimitBucketInput {
  bucketKey: string;
  windowMs: number;
}

export interface ConsumedRateLimitBucket {
  count: number;
  resetAt: number;
}

export type RateLimitBucketConsumer = (
  input: ConsumeRateLimitBucketInput
) => Promise<ConsumedRateLimitBucket>;

interface RedisScriptClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const CONSUME_FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

export const consumeRateLimitBucket = async (
  input: ConsumeRateLimitBucketInput,
  client: RedisScriptClient = getRedisClient()
): Promise<ConsumedRateLimitBucket> => {
  if (!input.bucketKey || input.bucketKey.length > 256) {
    throw new Error('Invalid rate-limit bucket key');
  }
  if (!Number.isSafeInteger(input.windowMs) || input.windowMs <= 0) {
    throw new Error('Invalid rate-limit window');
  }

  const redisKey = `${serverEnv.REDIS_KEY_PREFIX}:rate-limit:${input.bucketKey}`;
  const result = await client.eval(
    CONSUME_FIXED_WINDOW_SCRIPT,
    1,
    redisKey,
    input.windowMs,
  );
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error('Invalid rate-limit store response');
  }
  const count = Number(result[0]);
  const ttlMs = Number(result[1]);
  if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('Invalid rate-limit store response');
  }

  return { count, resetAt: Date.now() + ttlMs };
};

import IORedis, { Redis, RedisOptions } from 'ioredis';
import { serverEnv } from './env';
import { toSafeError } from './safeError';

let applicationRedis: Redis | null = null;

const handleRedisError = (error: Error) => {
  console.warn('[Redis] Connection error:', toSafeError(error));
};

export const getRedisClient = () => {
  if (!applicationRedis) {
    applicationRedis = new IORedis(serverEnv.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    applicationRedis.on('error', handleRedisError);
  }
  return applicationRedis;
};

export const connectRedis = async () => {
  const client = getRedisClient();
  if (client.status === 'wait') await client.connect();
  await client.ping();
};

export const checkRedisReady = async () => {
  await connectRedis();
};

export const closeRedis = async () => {
  const client = applicationRedis;
  applicationRedis = null;
  if (!client) return;
  client.removeListener('error', handleRedisError);
  if (client.status === 'end') return;
  await client.quit().catch(() => client.disconnect());
};

export const getBullMqConnectionOptions = (): RedisOptions => {
  const parsed = new URL(serverEnv.REDIS_URL);
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }

  const database = parsed.pathname && parsed.pathname !== '/'
    ? Number.parseInt(parsed.pathname.slice(1), 10)
    : 0;
  if (!Number.isSafeInteger(database) || database < 0) {
    throw new Error('REDIS_URL database must be a non-negative integer');
  }

  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: database,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
};

export const BULLMQ_PREFIX = `${serverEnv.REDIS_KEY_PREFIX}:bull`;

import { checkDatabaseReady } from './db';
import { checkRagServiceReady } from './ragClient';
import { checkRedisReady } from './redis';
import { toSafeError } from './safeError';

export interface ReadyHealthDependencies {
  checkDatabaseReady?: typeof checkDatabaseReady;
  checkRedisReady?: typeof checkRedisReady;
  checkRagServiceReady?: typeof checkRagServiceReady;
}

export const readReadyHealth = async (
  dependencies: ReadyHealthDependencies = {},
  requestId?: string,
) => {
  const checkDatabase = dependencies.checkDatabaseReady || checkDatabaseReady;
  const checkRedis = dependencies.checkRedisReady || checkRedisReady;
  const checkRag = dependencies.checkRagServiceReady || checkRagServiceReady;
  const checks: Record<string, 'ok' | 'error'> = {
    postgres: 'error',
    redis: 'error',
    rag: 'error',
  };

  try {
    await checkDatabase();
    checks.postgres = 'ok';
  } catch (error) {
    console.warn('[Health] Postgres readiness check failed:', toSafeError(error, requestId));
  }

  try {
    await checkRedis();
    checks.redis = 'ok';
  } catch (error) {
    console.warn('[Health] Redis readiness check failed:', toSafeError(error, requestId));
  }

  try {
    await checkRag();
    checks.rag = 'ok';
  } catch (error) {
    console.warn('[Health] RAG readiness check failed:', toSafeError(error, requestId));
  }

  const ready = Object.values(checks).every((status) => status === 'ok');
  return {
    statusCode: ready ? 200 : 503,
    body: {
    status: ready ? 'ready' : 'not_ready',
    checks,
    },
  };
};

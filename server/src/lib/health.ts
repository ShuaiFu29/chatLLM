import { Request, Response } from 'express';
import { checkDatabaseReady } from './db';
import { checkRagServiceReady } from './ragClient';
import { checkRedisReady } from './redis';
import { toSafeError } from './safeError';

export const liveHealthHandler = (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
};

interface ReadyHealthDependencies {
  checkDatabaseReady?: typeof checkDatabaseReady;
  checkRedisReady?: typeof checkRedisReady;
  checkRagServiceReady?: typeof checkRagServiceReady;
}

export const createReadyHealthHandler = (dependencies: ReadyHealthDependencies = {}) => async (
  _req: Request,
  res: Response,
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
    console.warn('[Health] Postgres readiness check failed:', toSafeError(error, res.locals.requestId));
  }

  try {
    await checkRedis();
    checks.redis = 'ok';
  } catch (error) {
    console.warn('[Health] Redis readiness check failed:', toSafeError(error, res.locals.requestId));
  }

  try {
    await checkRag();
    checks.rag = 'ok';
  } catch (error) {
    console.warn('[Health] RAG readiness check failed:', toSafeError(error, res.locals.requestId));
  }

  const ready = Object.values(checks).every((status) => status === 'ok');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
  });
};

export const readyHealthHandler = createReadyHealthHandler();

import { Request, Response } from 'express';
import axios from 'axios';
import { checkDatabaseReady } from './db';
import { serverEnv } from './env';
import { toSafeError } from './safeError';

export const liveHealthHandler = (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
};

export const readyHealthHandler = async (_req: Request, res: Response) => {
  const checks: Record<string, 'ok' | 'error'> = {
    postgres: 'error',
    rag: 'error',
  };

  try {
    await checkDatabaseReady();
    checks.postgres = 'ok';
  } catch (error) {
    console.warn('[Health] Postgres readiness check failed:', toSafeError(error, res.locals.requestId));
  }

  try {
    const response = await axios.get(`${serverEnv.RAG_SERVICE_URL}/health`, {
      timeout: serverEnv.RAG_HEALTH_TIMEOUT_MS,
      validateStatus: () => true,
    });
    checks.rag = response.status >= 200 && response.status < 300 ? 'ok' : 'error';
  } catch (error) {
    console.warn('[Health] RAG readiness check failed:', toSafeError(error, res.locals.requestId));
  }

  const ready = Object.values(checks).every((status) => status === 'ok');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
  });
};

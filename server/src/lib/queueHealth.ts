import { Request, Response } from 'express';
import { query } from './db';
import { toSafeError } from './safeError';

export interface QueueHealthCounts {
  cleanup_pending: number;
  cleanup_exhausted: number;
  cleanup_expired_leases: number;
  ingestion_expired_leases: number;
  eval_expired_leases: number;
}

type QueueHealthRow = {
  [K in keyof QueueHealthCounts]: number | string;
};

const asCount = (value: number | string) => {
  const count = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
};

export const readQueueHealthCounts = async (): Promise<QueueHealthCounts> => {
  const { rows } = await query<QueueHealthRow>(
    `select
       (
         select count(*)::integer
         from artifact_cleanup_jobs
         where status in ('queued', 'waiting', 'failed', 'processing')
           and attempts < max_attempts
       ) as cleanup_pending,
       (
         select count(*)::integer
         from artifact_cleanup_jobs
         where status = 'failed'
           and attempts >= max_attempts
       ) as cleanup_exhausted,
       (
         select count(*)::integer
         from artifact_cleanup_jobs
         where status = 'processing'
           and lease_expires_at <= now()
       ) as cleanup_expired_leases,
       (
         select count(*)::integer
         from file_ingestion_jobs
         where status in ('queued', 'processing')
           and lease_expires_at <= now()
       ) as ingestion_expired_leases,
       (
         select count(*)::integer
         from rag_eval_runs
         where status = 'running'
           and lease_token is not null
           and lease_expires_at <= now()
       ) as eval_expired_leases`,
  );
  const row = rows[0];
  if (!row) throw new Error('Queue health query returned no row');

  return {
    cleanup_pending: asCount(row.cleanup_pending),
    cleanup_exhausted: asCount(row.cleanup_exhausted),
    cleanup_expired_leases: asCount(row.cleanup_expired_leases),
    ingestion_expired_leases: asCount(row.ingestion_expired_leases),
    eval_expired_leases: asCount(row.eval_expired_leases),
  };
};

export const classifyQueueHealth = (counts: QueueHealthCounts) => {
  const cleanupDegraded = counts.cleanup_exhausted > 0 || counts.cleanup_expired_leases > 0;
  const ingestionDegraded = counts.ingestion_expired_leases > 0;
  const evalDegraded = counts.eval_expired_leases > 0;
  const degraded = cleanupDegraded || ingestionDegraded || evalDegraded;

  return {
    status: degraded ? 'degraded' as const : 'ok' as const,
    checks: {
      cleanup: {
        status: cleanupDegraded ? 'degraded' as const : 'ok' as const,
        pending: counts.cleanup_pending,
        exhausted: counts.cleanup_exhausted,
        expired_leases: counts.cleanup_expired_leases,
      },
      ingestion_leases: {
        status: ingestionDegraded ? 'degraded' as const : 'ok' as const,
        expired: counts.ingestion_expired_leases,
      },
      eval_leases: {
        status: evalDegraded ? 'degraded' as const : 'ok' as const,
        expired: counts.eval_expired_leases,
      },
    },
  };
};

export const createQueueHealthHandler = (
  readCounts: () => Promise<QueueHealthCounts> = readQueueHealthCounts,
) => async (_req: Request, res: Response) => {
  try {
    const result = classifyQueueHealth(await readCounts());
    res.status(result.status === 'ok' ? 200 : 503).json(result);
  } catch (error) {
    const requestId = res.locals.requestId as string | undefined;
    console.warn('[Health] Queue health check failed:', toSafeError(error, requestId));
    res.status(503).json({
      status: 'unavailable',
      checks: {
        cleanup: { status: 'error' },
        ingestion_leases: { status: 'error' },
        eval_leases: { status: 'error' },
      },
      ...(requestId ? { requestId } : {}),
    });
  }
};

export const queueHealthHandler = createQueueHealthHandler();

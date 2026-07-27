import { Queue, Worker } from 'bullmq';
import { serverEnv } from '../lib/env';
import { metrics } from '../lib/metrics';
import { ingestRagFile, IngestRagFileInput } from '../lib/ragClient';
import { BULLMQ_PREFIX, getBullMqConnectionOptions } from '../lib/redis';
import { toSafeError } from '../lib/safeError';
import {
  claimPendingFileById,
  FileIngestionClaim,
  FileIngestionReconciliation,
  listDispatchableFileIds,
  reconcileFileIngestionAttempt,
  reconcileFileIngestionJobs,
  renewFileIngestionLease,
} from '../repositories/files';

export const FILE_INGESTION_QUEUE_NAME = 'chatllm-file-ingestion-v1';
const FILE_INGESTION_JOB_NAME = 'ingest-file';

export interface FileIngestionQueuePayload {
  fileId: string;
}

export const buildFileIngestionQueueJob = (fileId: string) => ({
  name: FILE_INGESTION_JOB_NAME,
  data: { fileId } satisfies FileIngestionQueuePayload,
  opts: {
    jobId: `file-${fileId}`,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  },
});

type HeartbeatStopper = () => void | Promise<void>;

interface ExecuteFileIngestionAttemptOptions {
  ingestFile?: (input: IngestRagFileInput, signal?: AbortSignal) => Promise<unknown>;
  startHeartbeat?: (
    claim: FileIngestionClaim,
    onLeaseLost: () => void,
  ) => HeartbeatStopper;
  reconcileAttempt?: (
    claim: FileIngestionClaim,
  ) => Promise<FileIngestionReconciliation>;
  warn?: (message: string, error: unknown) => void;
}

const defaultWarn = (message: string, error: unknown) => {
  console.warn(message, toSafeError(error));
};

const startFileIngestionHeartbeat = (
  claim: FileIngestionClaim,
  onLeaseLost: () => void,
  warn: (message: string, error: unknown) => void,
): HeartbeatStopper => {
  const heartbeatMs = Math.max(1000, Math.floor(serverEnv.FILE_QUEUE_STALE_AFTER_MS / 3));
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(runHeartbeat, heartbeatMs);
    timer.unref();
  };

  const runHeartbeat = () => {
    timer = null;
    inFlight = renewFileIngestionLease(claim, {
      leaseDurationMs: serverEnv.FILE_QUEUE_STALE_AFTER_MS,
    }).then((leaseExpiresAt) => {
      if (leaseExpiresAt) return;
      stopped = true;
      onLeaseLost();
    }).catch((error) => {
      warn('[FileQueue] Failed to renew ingestion lease:', error);
    }).finally(schedule);
  };

  schedule();
  return async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await inFlight;
  };
};

export const executeFileIngestionAttempt = async (
  claim: FileIngestionClaim,
  options: ExecuteFileIngestionAttemptOptions = {},
): Promise<FileIngestionReconciliation> => {
  const ingestFile = options.ingestFile || ingestRagFile;
  const reconcileAttempt = options.reconcileAttempt || reconcileFileIngestionAttempt;
  const warn = options.warn || defaultWarn;
  const controller = new AbortController();
  const startHeartbeat = options.startHeartbeat || ((activeClaim, onLeaseLost) => (
    startFileIngestionHeartbeat(activeClaim, onLeaseLost, warn)
  ));
  const stopHeartbeat = startHeartbeat(claim, () => controller.abort());

  try {
    await ingestFile({
      fileId: claim.file.id,
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
    }, controller.signal);
  } catch (error) {
    warn('[FileQueue] RAG ingestion request ended before reconciliation:', error);
  } finally {
    try {
      await stopHeartbeat();
    } catch (error) {
      warn('[FileQueue] Failed to stop ingestion heartbeat cleanly:', error);
    }
  }

  return reconcileAttempt(claim);
};

export const shouldContinueFileQueueBatch = (
  claimedCount: number,
  concurrency: number,
  results: FileIngestionReconciliation[],
) => claimedCount === concurrency && results.every((result) => result.state !== 'active');

class FileQueueService {
  private isDispatching = false;
  private interval: NodeJS.Timeout | null = null;
  private queue: Queue<FileIngestionQueuePayload> | null = null;
  private worker: Worker<FileIngestionQueuePayload> | null = null;
  private intervalMs = serverEnv.FILE_QUEUE_INTERVAL_MS;
  private concurrency = serverEnv.FILE_QUEUE_CONCURRENCY;
  private staleAfterMs = serverEnv.FILE_QUEUE_STALE_AFTER_MS;

  async start() {
    if (this.queue || this.worker) return;
    const connection = getBullMqConnectionOptions();
    this.queue = new Queue(FILE_INGESTION_QUEUE_NAME, {
      connection,
      prefix: BULLMQ_PREFIX,
    });
    this.worker = new Worker(
      FILE_INGESTION_QUEUE_NAME,
      async (job) => this.processFileById(job.data.fileId),
      {
        connection,
        prefix: BULLMQ_PREFIX,
        concurrency: this.concurrency,
      },
    );
    this.worker.on('error', (error) => {
      console.error('[FileQueue] BullMQ worker error:', toSafeError(error));
    });
    await Promise.all([this.queue.waitUntilReady(), this.worker.waitUntilReady()]);
    await this.dispatchPending();
    this.interval = setInterval(() => this.dispatchPending(), this.intervalMs);
    this.interval.unref();
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const worker = this.worker;
    const queue = this.queue;
    this.worker = null;
    this.queue = null;
    await worker?.close();
    await queue?.close();
  }

  trigger() {
    void this.dispatchPending();
  }

  private async dispatchPending() {
    if (this.isDispatching || !this.queue) return;
    this.isDispatching = true;

    try {
      const limit = Math.max(20, this.concurrency * 10);
      await reconcileFileIngestionJobs({ limit });
      const fileIds = await listDispatchableFileIds(limit);
      if (fileIds.length > 0) {
        await this.queue.addBulk(fileIds.map(buildFileIngestionQueueJob));
      }
    } catch (error) {
      console.error('[FileQueue] Failed to dispatch pending files:', toSafeError(error));
    } finally {
      this.isDispatching = false;
    }
  }

  private async processFileById(fileId: string) {
    const claim = await claimPendingFileById(fileId, {
      maxAttempts: serverEnv.FILE_QUEUE_MAX_ATTEMPTS,
      retryBaseDelayMs: serverEnv.FILE_QUEUE_RETRY_BASE_DELAY_MS,
      staleAfterMs: this.staleAfterMs,
    });
    if (!claim) return { state: 'superseded' as const };
    metrics.recordFileQueueClaimed(1);
    metrics.recordFileQueueStarted();
    let status: FileIngestionReconciliation['state'] = 'failed';
    try {
      const result = await executeFileIngestionAttempt(claim);
      status = result.state;
    } catch (error) {
      console.warn('[FileQueue] Failed to reconcile ingestion attempt:', toSafeError(error));
    } finally {
      metrics.recordFileQueueFinished(status);
    }
    return { state: status };
  }
}

export const fileQueue = new FileQueueService();

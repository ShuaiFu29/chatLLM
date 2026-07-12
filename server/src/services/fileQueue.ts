import { serverEnv } from '../lib/env';
import { metrics } from '../lib/metrics';
import { ingestRagFile, IngestRagFileInput } from '../lib/ragClient';
import { toSafeError } from '../lib/safeError';
import {
  claimNextPendingFile,
  FileIngestionClaim,
  FileIngestionReconciliation,
  reconcileFileIngestionAttempt,
  reconcileFileIngestionJobs,
  renewFileIngestionLease,
} from '../repositories/files';

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
  private isProcessing = false;
  private interval: NodeJS.Timeout | null = null;
  private intervalMs = serverEnv.FILE_QUEUE_INTERVAL_MS;
  private concurrency = serverEnv.FILE_QUEUE_CONCURRENCY;
  private staleAfterMs = serverEnv.FILE_QUEUE_STALE_AFTER_MS;

  start() {
    if (this.interval) return;
    this.processPendingBatch();
    this.interval = setInterval(() => this.processPendingBatch(), this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  trigger() {
    this.processPendingBatch();
  }

  private async processPendingBatch() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      let shouldContinue = true;

      while (shouldContinue) {
        await reconcileFileIngestionJobs({
          limit: Math.max(10, this.concurrency * 4),
        });

        const claims: FileIngestionClaim[] = [];
        for (let index = 0; index < this.concurrency; index += 1) {
          const claim = await claimNextPendingFile({
            maxAttempts: serverEnv.FILE_QUEUE_MAX_ATTEMPTS,
            retryBaseDelayMs: serverEnv.FILE_QUEUE_RETRY_BASE_DELAY_MS,
            staleAfterMs: this.staleAfterMs,
          });
          if (!claim) break;
          claims.push(claim);
        }

        if (claims.length === 0) {
          shouldContinue = false;
          continue;
        }

        metrics.recordFileQueueClaimed(claims.length);
        const results = await Promise.all(claims.map((claim) => this.processFile(claim)));
        shouldContinue = shouldContinueFileQueueBatch(
          claims.length,
          this.concurrency,
          results,
        );
      }
    } catch (error) {
      console.error('[FileQueue] Failed to process pending file:', toSafeError(error));
    } finally {
      this.isProcessing = false;
    }
  }

  private async processFile(claim: FileIngestionClaim) {
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

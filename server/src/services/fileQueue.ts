import axios from 'axios';
import { serverEnv } from '../lib/env';
import { metrics } from '../lib/metrics';
import { claimNextPendingFile, FileRow, markFileAttemptFailed } from '../repositories/files';

class FileQueueService {
  private isProcessing = false;
  private interval: NodeJS.Timeout | null = null;
  private ragServiceUrl = serverEnv.RAG_SERVICE_URL;
  private intervalMs = serverEnv.FILE_QUEUE_INTERVAL_MS;
  private concurrency = serverEnv.FILE_QUEUE_CONCURRENCY;
  private ingestTimeoutMs = serverEnv.FILE_QUEUE_INGEST_TIMEOUT_MS;

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
        const files: FileRow[] = [];

        for (let index = 0; index < this.concurrency; index += 1) {
          const file = await claimNextPendingFile({
            maxAttempts: serverEnv.FILE_QUEUE_MAX_ATTEMPTS,
            retryBaseDelayMs: serverEnv.FILE_QUEUE_RETRY_BASE_DELAY_MS,
            staleAfterMs: serverEnv.FILE_QUEUE_STALE_AFTER_MS,
          });
          if (!file) break;
          files.push(file);
        }

        if (files.length === 0) {
          shouldContinue = false;
          continue;
        }

        metrics.recordFileQueueClaimed(files.length);
        await Promise.all(files.map((file) => this.processFile(file)));
        shouldContinue = files.length === this.concurrency;
      }
    } catch (err) {
      console.error('[FileQueue] Failed to process pending file:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  private async processFile(file: FileRow) {
    metrics.recordFileQueueStarted();
    let status: 'completed' | 'failed' = 'failed';
    try {
      await axios.post(`${this.ragServiceUrl}/ingest-sync`, {
        file_id: file.id,
      }, { timeout: this.ingestTimeoutMs });
      status = 'completed';
    } catch (err: any) {
      const message = `RAG Service unavailable: ${err.message}`;
      await markFileAttemptFailed(file, message);
    } finally {
      metrics.recordFileQueueFinished(status);
    }
  }
}

export const fileQueue = new FileQueueService();

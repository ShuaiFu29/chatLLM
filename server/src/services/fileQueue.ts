import axios from 'axios';
import { serverEnv } from '../lib/env';
import { claimNextPendingFile, updateFile } from '../repositories/files';

class FileQueueService {
  private isProcessing = false;
  private interval: NodeJS.Timeout | null = null;
  private ragServiceUrl = serverEnv.RAG_SERVICE_URL;

  start() {
    if (this.interval) return;
    this.processNextFile();
    this.interval = setInterval(() => this.processNextFile(), 5000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  trigger() {
    this.processNextFile();
  }

  private async processNextFile() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const file = await claimNextPendingFile();
      if (!file) return;

      try {
        await axios.post(`${this.ragServiceUrl}/ingest`, {
          file_id: file.id,
        }, { timeout: 10000 });
      } catch (err: any) {
        await updateFile(file.id, {
          status: 'failed',
          error_message: `RAG Service unavailable: ${err.message}`,
        });
      }
    } catch (err) {
      console.error('[FileQueue] Failed to process pending file:', err);
    } finally {
      this.isProcessing = false;
    }
  }
}

export const fileQueue = new FileQueueService();

import path from 'path';
import fs from 'fs-extra';
import { serverEnv } from '../lib/env';
import { metrics } from '../lib/metrics';
import { failStaleRunningRagEvalRuns, resetStaleRagEvalRunJobs } from '../repositories/ragEval';
import { deleteExpiredSessions } from '../repositories/sessions';
import { abortMultipartObjectUpload } from '../lib/storage';
import {
  listExpiredMultipartUploadSessions,
  markMultipartUploadSessionExpired,
} from '../repositories/uploadMultipart';
import { deleteAbandonedUploadingFiles, updateFile } from '../repositories/files';

const UPLOAD_TEMP_DIR = path.join(__dirname, '../../uploads/temp');
const ABANDONED_UPLOAD_RECORD_MAX_AGE_MS = Math.min(
  serverEnv.UPLOAD_TEMP_MAX_AGE_MS,
  60 * 60 * 1000
);

export const cleanupUploadTempDirectory = async (
  uploadDir = UPLOAD_TEMP_DIR,
  maxAgeMs = serverEnv.UPLOAD_TEMP_MAX_AGE_MS
) => {
  await fs.ensureDir(uploadDir);

  const entries = await fs.readdir(uploadDir);
  const now = Date.now();

  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(uploadDir, entry);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) return;

    if (now - stat.mtimeMs >= maxAgeMs) {
      await fs.remove(fullPath);
    }
  }));
};

export const cleanupExpiredMultipartUploadSessions = async () => {
  const sessions = await listExpiredMultipartUploadSessions(20);

  await Promise.all(sessions.map(async (session) => {
    const message = 'Multipart upload session expired';
    await abortMultipartObjectUpload(session.object_key, session.storage_upload_id).catch(() => undefined);
    await markMultipartUploadSessionExpired(session.file_id, message);
    await updateFile(session.file_id, {
      status: 'failed',
      progress: 0,
      error_message: message,
    });
  }));
};

export const cleanupAbandonedUploadRecords = async () => {
  return deleteAbandonedUploadingFiles(ABANDONED_UPLOAD_RECORD_MAX_AGE_MS, 50);
};

class MaintenanceService {
  private interval: NodeJS.Timeout | null = null;

  start() {
    if (this.interval) return;

    this.runOnce();
    this.interval = setInterval(() => this.runOnce(), serverEnv.MAINTENANCE_INTERVAL_MS);
    this.interval.unref();
  }

  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  private async runOnce() {
    const results = await Promise.allSettled([
      deleteExpiredSessions(),
      this.resetStaleRagEvalRunJobs(),
      this.failStaleRunningRagEvalRuns(),
      cleanupUploadTempDirectory(),
      cleanupExpiredMultipartUploadSessions(),
      this.cleanupAbandonedUploadRecords(),
    ]);

    results.forEach((result) => {
      if (result.status === 'rejected') {
        console.warn('[Maintenance] Cleanup task failed:', result.reason);
      }
    });
  }

  private async failStaleRunningRagEvalRuns() {
    const count = await failStaleRunningRagEvalRuns(serverEnv.RAG_EVAL_STALE_RUN_MS);
    metrics.recordRagEvalRunsStaleFailed(count);
  }

  private async resetStaleRagEvalRunJobs() {
    const count = await resetStaleRagEvalRunJobs(serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS);
    if (count > 0) {
      console.warn(`[Maintenance] Reset ${count} stale RAG eval queue jobs`);
    }
  }

  private async cleanupAbandonedUploadRecords() {
    const count = await cleanupAbandonedUploadRecords();
    if (count > 0) {
      console.warn(`[Maintenance] Removed ${count} abandoned uploading file records`);
    }
  }
}

export const maintenanceService = new MaintenanceService();

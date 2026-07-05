import path from 'path';
import fs from 'fs-extra';
import { serverEnv } from '../lib/env';
import { failStaleRunningRagEvalRuns } from '../repositories/ragEval';
import { deleteExpiredSessions } from '../repositories/sessions';

const UPLOAD_TEMP_DIR = path.join(__dirname, '../../uploads/temp');

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
      failStaleRunningRagEvalRuns(serverEnv.RAG_EVAL_STALE_RUN_MS),
      cleanupUploadTempDirectory(),
    ]);

    results.forEach((result) => {
      if (result.status === 'rejected') {
        console.warn('[Maintenance] Cleanup task failed:', result.reason);
      }
    });
  }
}

export const maintenanceService = new MaintenanceService();

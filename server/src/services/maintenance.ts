import path from 'path';
import fs from 'fs-extra';
import { serverEnv } from '../lib/env';
import { metrics } from '../lib/metrics';
import { failStaleRunningRagEvalRuns, resetStaleRagEvalRunJobs } from '../repositories/ragEval';
import { deleteExpiredSessions } from '../repositories/sessions';
import { failExpiredSubagentRunLeases } from '../repositories/agentSubagentQueue';
import { settleExpiredAgentModelInvocations } from '../repositories/agentRunBudgets';
import {
  deleteExpiredAgentRunCancelIntents,
  failStaleAgentRuns as failStaleAgentRunsRepository,
} from '../repositories/agentRuns';
import {
  abortMultipartObjectUpload,
  deleteObject,
  headObjectMetadata,
  isMultipartUploadMissingError,
  isObjectNotFoundError,
} from '../lib/storage';
import {
  assertCompletedMultipartObject,
  MultipartCompletionIntegrityError,
} from '../lib/multipartCompletion';
import {
  claimExpiredMultipartUploadAbort,
  finalizeMultipartUploadAbort,
  finalizeMultipartUploadCompletion,
  listExpiredMultipartUploadSessions,
  markMultipartUploadAbortRetryable,
} from '../repositories/uploadMultipart';
import { deleteAbandonedUploadingFiles } from '../repositories/files';
import { toSafeError } from '../lib/safeError';
import { failStaleAgentVersionDryRuns } from '../repositories/agentDryRuns';
import { failExpiredAgentEvalRuns, resetStaleAgentEvalRuns } from '../repositories/agentEval';

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
    // entry is a direct basename returned by fs.readdir, not request-controlled path input.
    const fullPath = path.join(uploadDir, entry); // nosemgrep
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
    if (session.status === 'completing') {
      try {
        const object = await headObjectMetadata(session.object_key);
        const storageBytes = assertCompletedMultipartObject(object, session);
        const result = await finalizeMultipartUploadCompletion(
          session.file_id,
          session.user_id,
          session.object_key,
          storageBytes
        );
        if (result.transitioned || result.session?.status === 'completed') return;
        return;
      } catch (error) {
        if (error instanceof MultipartCompletionIntegrityError) {
          await deleteObject(session.object_key);
        } else if (!isObjectNotFoundError(error)) {
          console.warn('[Maintenance] Multipart completion reconciliation failed:', toSafeError(error));
          return;
        }
      }
    }

    const claimed = session.status === 'cancelling'
      ? session
      : await claimExpiredMultipartUploadAbort(session.file_id, session.user_id);
    if (!claimed) return;

    try {
      await abortMultipartObjectUpload(claimed.object_key, claimed.storage_upload_id);
    } catch (error) {
      if (!isMultipartUploadMissingError(error)) {
        await markMultipartUploadAbortRetryable(
          claimed.file_id,
          claimed.user_id,
          'Expired multipart storage abort is pending reconciliation'
        );
        return;
      }
    }

    await finalizeMultipartUploadAbort(
      claimed.file_id,
      claimed.user_id,
      message,
      'expired'
    );
  }));
};

export const cleanupAbandonedUploadRecords = async () => {
  return deleteAbandonedUploadingFiles(ABANDONED_UPLOAD_RECORD_MAX_AGE_MS, 50);
};

class MaintenanceService {
  private interval: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private started = false;

  start() {
    if (this.started) return;

    this.started = true;
    void this.runScheduledTasks();
    this.interval = setInterval(() => {
      void this.runScheduledTasks();
    }, serverEnv.MAINTENANCE_INTERVAL_MS);
    this.interval.unref();
  }

  async stop() {
    this.started = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.activeRun;
  }

  private runScheduledTasks() {
    if (!this.started) return Promise.resolve();
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.runOnce()
      .catch((error) => {
        console.warn('[Maintenance] Cleanup run failed:', toSafeError(error));
      })
      .finally(() => {
        this.activeRun = null;
      });
    return this.activeRun;
  }

  private async runOnce() {
    const results = await Promise.allSettled([
      deleteExpiredSessions(),
      deleteExpiredAgentRunCancelIntents(),
      this.recoverStaleAgentRuns(),
      this.failExpiredSubagentLeases(),
      this.settleExpiredAgentModelInvocations(),
      this.resetStaleRagEvalRunJobs(),
      this.failStaleRunningRagEvalRuns(),
      this.failStaleAgentDryRuns(),
      this.recoverAgentEvalRuns(),
      cleanupUploadTempDirectory(),
      cleanupExpiredMultipartUploadSessions(),
      this.cleanupAbandonedUploadRecords(),
    ]);

    results.forEach((result) => {
      if (result.status === 'rejected') {
        console.warn('[Maintenance] Cleanup task failed:', toSafeError(result.reason));
      }
    });
  }

  private async failStaleRunningRagEvalRuns() {
    const count = await failStaleRunningRagEvalRuns(serverEnv.RAG_EVAL_STALE_RUN_MS);
    metrics.recordRagEvalRunsStaleFailed(count);
  }

  private async recoverStaleAgentRuns() {
    const count = await failStaleAgentRunsRepository(serverEnv.AGENT_RUN_STALE_AFTER_MS);
    if (count > 0) {
      console.warn(`[Maintenance] Recovered ${count} stale Agent runs`);
    }
  }

  /**
   * Fail dispatched subagent runs whose worker stopped renewing its lease.
   *
   * Not re-queued: a child's progress through its own tool calls is not
   * checkpointed, so restarting it could repeat a side effect that already
   * happened. The parent sees a failed subtask, which it can report honestly.
   */
  private async failExpiredSubagentLeases() {
    const failed = await failExpiredSubagentRunLeases();
    if (failed.length > 0) {
      console.warn(`[Maintenance] Failed ${failed.length} subagent runs with expired leases`);
    }
  }

  private async failStaleAgentDryRuns() {
    const staleBefore = new Date(Date.now() - Math.max(5 * 60 * 1000, serverEnv.AGENT_RUN_STALE_AFTER_MS));
    const ids = await failStaleAgentVersionDryRuns(staleBefore);
    if (ids.length > 0) {
      console.warn(`[Maintenance] Failed ${ids.length} interrupted Agent dry-runs`);
    }
  }

  private async recoverAgentEvalRuns() {
    const [resetCount, failedCount] = await Promise.all([
      resetStaleAgentEvalRuns(),
      failExpiredAgentEvalRuns(),
    ]);
    if (resetCount > 0 || failedCount > 0) {
      console.warn(
        `[Maintenance] Agent eval recovery reset ${resetCount} run(s) and failed ${failedCount} expired run(s)`,
      );
    }
  }

  private async settleExpiredAgentModelInvocations() {
    const invocationIds = await settleExpiredAgentModelInvocations();
    if (invocationIds.length > 0) {
      console.warn(
        `[Maintenance] Conservatively settled ${invocationIds.length} abandoned Agent model reservations`,
      );
    }
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

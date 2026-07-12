import { randomUUID } from 'crypto';
import { cleanupRagFileVectors } from '../lib/ragClient';
import {
  abortMultipartObjectUpload,
  deleteObject,
  isMultipartUploadMissingError,
} from '../lib/storage';
import { toSafeError } from '../lib/safeError';
import {
  claimNextCleanupJob,
  CleanupJobClaim,
  CleanupLeaseLostError,
  failExhaustedCleanupJobs,
  finalizeAccountCleanup,
  finalizeAvatarCleanup,
  finalizeFileCleanup,
  finalizeProjectSpaceCleanup,
  getCleanupChildSummary,
  markCleanupJobFailed,
  markCleanupJobWaiting,
  renewCleanupJobLease,
  updateCleanupJobStep,
} from '../repositories/cleanupJobs';

const CLEANUP_QUEUE_INTERVAL_MS = 5000;
const CLEANUP_QUEUE_CONCURRENCY = 2;
const CLEANUP_QUEUE_STALE_AFTER_MS = 15 * 60 * 1000;
const CLEANUP_QUEUE_RETRY_BASE_DELAY_MS = 60 * 1000;

interface CleanupChildSummary {
  pending: number;
  failed: number;
}

interface ExecuteArtifactCleanupJobOptions {
  cleanupRagFile?: (fileId: string) => Promise<unknown>;
  abortMultipartUpload?: (payload: Record<string, unknown>) => Promise<unknown>;
  deleteStorageObject?: (key?: string | null) => Promise<unknown>;
  updateStep?: (claim: CleanupJobClaim, step: string) => Promise<unknown>;
  finalizeFile?: (claim: CleanupJobClaim) => Promise<unknown>;
  summarizeChildren?: (parentJobId: string) => Promise<CleanupChildSummary>;
  markWaiting?: (claim: CleanupJobClaim) => Promise<unknown>;
  finalizeProjectSpace?: (claim: CleanupJobClaim) => Promise<unknown>;
  finalizeAccount?: (claim: CleanupJobClaim) => Promise<unknown>;
  finalizeAvatar?: (claim: CleanupJobClaim) => Promise<unknown>;
  markFailed?: (claim: CleanupJobClaim, safeError: string) => Promise<unknown>;
  warn?: (message: string, error: unknown) => void;
}

const defaultWarn = (message: string, error: unknown) => {
  console.warn(message, toSafeError(error));
};

const abortMultipartFromPayload = async (payload: Record<string, unknown>) => {
  const objectKey = typeof payload.multipart_object_key === 'string'
    ? payload.multipart_object_key
    : null;
  const uploadId = typeof payload.multipart_upload_id === 'string'
    ? payload.multipart_upload_id
    : null;
  if (!objectKey || !uploadId) return;

  try {
    await abortMultipartObjectUpload(objectKey, uploadId);
  } catch (error) {
    if (!isMultipartUploadMissingError(error)) throw error;
  }
};

const storageKeysFromPayload = (payload: Record<string, unknown>) => Array.from(new Set(
  [payload.object_key, payload.multipart_object_key]
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
));

export const executeArtifactCleanupJob = async (
  job: CleanupJobClaim,
  options: ExecuteArtifactCleanupJobOptions = {}
): Promise<{ state: 'completed' | 'waiting' | 'failed' | 'superseded' }> => {
  const cleanupRagFile = options.cleanupRagFile || cleanupRagFileVectors;
  const abortMultipartUpload = options.abortMultipartUpload || abortMultipartFromPayload;
  const deleteStorageObject = options.deleteStorageObject || deleteObject;
  const updateStep = options.updateStep || updateCleanupJobStep;
  const finalizeFile = options.finalizeFile || finalizeFileCleanup;
  const summarizeChildren = options.summarizeChildren || getCleanupChildSummary;
  const markWaiting = options.markWaiting || ((claim) => markCleanupJobWaiting(claim));
  const finalizeProjectSpace = options.finalizeProjectSpace || finalizeProjectSpaceCleanup;
  const finalizeAccount = options.finalizeAccount || finalizeAccountCleanup;
  const finalizeAvatar = options.finalizeAvatar || finalizeAvatarCleanup;
  const markFailed = options.markFailed || ((claim, message) => (
    markCleanupJobFailed(claim, message, CLEANUP_QUEUE_RETRY_BASE_DELAY_MS)
  ));
  const warn = options.warn || defaultWarn;
  const completedSteps = { ...(job.step_state || {}) };
  let currentStep = 'job execution';

  try {
    if (job.resource_type === 'file') {
      if (!completedSteps.rag_deleted) {
        currentStep = 'RAG cleanup';
        await cleanupRagFile(job.resource_id);
        await updateStep(job, 'rag_deleted');
        completedSteps.rag_deleted = true;
      }

      if (!completedSteps.multipart_aborted) {
        currentStep = 'multipart cleanup';
        await abortMultipartUpload(job.payload || {});
        await updateStep(job, 'multipart_aborted');
        completedSteps.multipart_aborted = true;
      }

      if (!completedSteps.storage_deleted) {
        currentStep = 'storage cleanup';
        for (const key of storageKeysFromPayload(job.payload || {})) {
          await deleteStorageObject(key);
        }
        await updateStep(job, 'storage_deleted');
        completedSteps.storage_deleted = true;
      }

      currentStep = 'file finalization';
      await finalizeFile(job);
      return { state: 'completed' };
    }

    if (job.resource_type === 'project_space' || job.resource_type === 'account') {
      currentStep = 'child cleanup reconciliation';
      const children = await summarizeChildren(job.id);
      if (children.failed > 0) {
        throw new Error('A child cleanup exhausted its retries');
      }
      if (children.pending > 0) {
        await markWaiting(job);
        return { state: 'waiting' };
      }

      if (job.resource_type === 'account' && !completedSteps.avatar_deleted) {
        currentStep = 'avatar cleanup';
        const avatarObjectKey = typeof job.payload?.avatar_object_key === 'string'
          ? job.payload.avatar_object_key
          : null;
        await deleteStorageObject(avatarObjectKey);
        await updateStep(job, 'avatar_deleted');
        completedSteps.avatar_deleted = true;
      }

      currentStep = job.resource_type === 'account'
        ? 'account finalization'
        : 'project space finalization';
      if (job.resource_type === 'account') await finalizeAccount(job);
      else await finalizeProjectSpace(job);
      return { state: 'completed' };
    }

    if (job.resource_type === 'avatar') {
      if (!completedSteps.storage_deleted) {
        currentStep = 'avatar storage cleanup';
        const objectKey = typeof job.payload?.object_key === 'string'
          ? job.payload.object_key
          : null;
        await deleteStorageObject(objectKey);
        await updateStep(job, 'storage_deleted');
      }
      currentStep = 'avatar finalization';
      await finalizeAvatar(job);
      return { state: 'completed' };
    }

    throw new Error('Unsupported cleanup resource type');
  } catch (error) {
    if (error instanceof CleanupLeaseLostError) return { state: 'superseded' };
    warn('[CleanupQueue] Artifact cleanup attempt failed:', error);
    const safeError = `Artifact cleanup failed during ${currentStep}`;
    try {
      await markFailed(job, safeError);
      return { state: 'failed' };
    } catch (markError) {
      if (markError instanceof CleanupLeaseLostError) return { state: 'superseded' };
      throw markError;
    }
  }
};

const startCleanupHeartbeat = (
  job: CleanupJobClaim,
  warn: (message: string, error: unknown) => void
) => {
  const heartbeatMs = Math.max(1000, Math.floor(CLEANUP_QUEUE_STALE_AFTER_MS / 3));
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
    inFlight = renewCleanupJobLease(job, {
      leaseDurationMs: CLEANUP_QUEUE_STALE_AFTER_MS,
    }).then((renewed) => {
      if (!renewed) stopped = true;
    }).catch((error) => {
      warn('[CleanupQueue] Failed to renew cleanup lease:', error);
    }).finally(schedule);
  };

  schedule();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
};

class ArtifactCleanupQueue {
  private workerId = randomUUID();
  private interval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  start() {
    if (this.interval) return;
    this.processPendingBatch();
    this.interval = setInterval(() => this.processPendingBatch(), CLEANUP_QUEUE_INTERVAL_MS);
    this.interval.unref();
  }

  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  trigger() {
    this.processPendingBatch();
  }

  private async processJob(job: CleanupJobClaim) {
    const stopHeartbeat = startCleanupHeartbeat(job, defaultWarn);
    try {
      return await executeArtifactCleanupJob(job);
    } finally {
      await stopHeartbeat();
    }
  }

  private async processPendingBatch() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      await failExhaustedCleanupJobs();
      let shouldContinue = true;
      while (shouldContinue) {
        const jobs: CleanupJobClaim[] = [];
        for (let index = 0; index < CLEANUP_QUEUE_CONCURRENCY; index += 1) {
          const job = await claimNextCleanupJob(this.workerId, {
            leaseDurationMs: CLEANUP_QUEUE_STALE_AFTER_MS,
          });
          if (!job) break;
          jobs.push(job);
        }
        if (jobs.length === 0) break;
        await Promise.all(jobs.map((job) => this.processJob(job)));
        shouldContinue = jobs.length === CLEANUP_QUEUE_CONCURRENCY;
      }
    } catch (error) {
      console.error('[CleanupQueue] Failed to process cleanup jobs:', toSafeError(error));
    } finally {
      this.isProcessing = false;
    }
  }
}

export const artifactCleanupQueue = new ArtifactCleanupQueue();

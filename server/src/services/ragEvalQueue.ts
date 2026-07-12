import os from 'os';
import { serverEnv } from '../lib/env';
import { metrics } from '../lib/metrics';
import {
  RagEvalRunInput,
  RagEvalRunResponse,
  runRagEvaluation,
} from '../lib/ragClient';
import { toSafeError } from '../lib/safeError';
import {
  ClaimedRagEvalRunJob,
  completeRagEvalRunWithResults,
  failRagEvalRunForUser,
  markRagEvalRunAttemptFailed,
  claimNextRagEvalRunJob,
  RagEvalDatasetRow,
  renewRagEvalRunLease,
} from '../repositories/ragEval';

const toRagEvalCases = (dataset: RagEvalDatasetRow) => (dataset.cases || []).map((testCase) => ({
  id: testCase.id,
  question: testCase.question,
  expected_answer: testCase.expected_answer,
  expected_keywords: testCase.expected_keywords,
  expected_source_files: testCase.expected_source_files,
}));

type HeartbeatStopper = () => void | Promise<void>;

interface ExecuteRagEvalRequestOptions {
  runEvaluation?: (
    input: RagEvalRunInput,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => Promise<RagEvalRunResponse>;
  startHeartbeat?: (
    job: ClaimedRagEvalRunJob,
    onLeaseLost: () => void,
  ) => HeartbeatStopper;
  registerController?: (
    runId: string,
    leaseToken: string,
    controller: AbortController,
  ) => () => void;
  now?: () => number;
  warn?: (message: string, error: unknown) => void;
}

const defaultWarn = (message: string, error: unknown) => {
  console.warn(message, toSafeError(error));
};

const toIsoString = (value: string | Date) => (
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()
);

const startRagEvalHeartbeat = (
  job: ClaimedRagEvalRunJob,
  onLeaseLost: () => void,
  warn: (message: string, error: unknown) => void,
): HeartbeatStopper => {
  const heartbeatMs = Math.max(
    1000,
    Math.floor(serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS / 4),
  );
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
    inFlight = renewRagEvalRunLease({
      runId: job.id,
      workerId: job.worker_id || '',
      leaseToken: job.lease_token,
      leaseDurationMs: serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS,
    }).then((leaseExpiresAt) => {
      if (leaseExpiresAt) return;
      stopped = true;
      onLeaseLost();
    }).catch((error) => {
      stopped = true;
      warn('[RagEvalQueue] Failed to renew evaluation lease:', error);
      onLeaseLost();
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

export const executeRagEvalRequest = async (
  job: ClaimedRagEvalRunJob,
  options: ExecuteRagEvalRequestOptions = {},
) => {
  const now = options.now || Date.now;
  const warn = options.warn || defaultWarn;
  const runEvaluation = options.runEvaluation || runRagEvaluation;
  const deadlineAt = toIsoString(job.deadline_at);
  const remainingMs = Math.floor(new Date(deadlineAt).getTime() - now());
  if (remainingMs <= 0) throw new Error('RAG evaluation deadline exceeded');

  const controller = new AbortController();
  const unregisterController = options.registerController?.(
    job.id,
    job.lease_token,
    controller,
  ) || (() => undefined);
  const startHeartbeat = options.startHeartbeat || ((activeJob, onLeaseLost) => (
    startRagEvalHeartbeat(activeJob, onLeaseLost, warn)
  ));
  const stopHeartbeat = startHeartbeat(job, () => controller.abort());

  try {
    return await runEvaluation({
      run_id: job.id,
      lease_token: job.lease_token,
      deadline_at: deadlineAt,
      case_timeout_ms: job.case_timeout_ms,
      user_id: job.user_id,
      project_space_id: job.dataset.project_space_id,
      cases: toRagEvalCases(job.dataset),
      limit: 10,
      threshold: 0.1,
    }, controller.signal, remainingMs);
  } finally {
    try {
      await stopHeartbeat();
    } catch (error) {
      warn('[RagEvalQueue] Failed to stop evaluation heartbeat cleanly:', error);
    }
    unregisterController();
  }
};

class RagEvalQueueService {
  private isProcessing = false;
  private interval: NodeJS.Timeout | null = null;
  private workerId = `${os.hostname()}:${process.pid}:rag-eval`;
  private intervalMs = serverEnv.RAG_EVAL_QUEUE_INTERVAL_MS;
  private concurrency = serverEnv.RAG_EVAL_QUEUE_CONCURRENCY;
  private activeControllers = new Map<string, {
    leaseToken: string;
    controller: AbortController;
  }>();

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
    for (const active of this.activeControllers.values()) active.controller.abort();
    this.activeControllers.clear();
  }

  trigger() {
    this.processPendingBatch();
  }

  abortRun(runId: string) {
    const active = this.activeControllers.get(runId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  private registerController(
    runId: string,
    leaseToken: string,
    controller: AbortController,
  ) {
    this.activeControllers.set(runId, { leaseToken, controller });
    return () => {
      const active = this.activeControllers.get(runId);
      if (active?.leaseToken === leaseToken && active.controller === controller) {
        this.activeControllers.delete(runId);
      }
    };
  }

  private async processPendingBatch() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      let shouldContinue = true;

      while (shouldContinue) {
        const jobs: ClaimedRagEvalRunJob[] = [];

        for (let index = 0; index < this.concurrency; index += 1) {
          const job = await claimNextRagEvalRunJob({
            workerId: this.workerId,
            maxAttempts: serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS,
            retryBaseDelayMs: serverEnv.RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS,
            staleAfterMs: serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS,
            runTimeoutMs: serverEnv.RAG_EVAL_RUN_TIMEOUT_MS,
          });

          if (!job) break;
          metrics.recordRagEvalRunQueueClaimed();
          jobs.push(job);
        }

        if (jobs.length === 0) {
          shouldContinue = false;
          continue;
        }

        await Promise.all(jobs.map((job) => this.processRun(job)));
        shouldContinue = jobs.length === this.concurrency;
      }
    } catch (error) {
      console.error('[RagEvalQueue] Failed to process queued eval run:', toSafeError(error));
    } finally {
      this.isProcessing = false;
    }
  }

  private async processRun(job: ClaimedRagEvalRunJob) {
    const startedAt = Date.now();

    try {
      if (!job.dataset.cases || job.dataset.cases.length === 0) {
        const failedRun = await failRagEvalRunForUser({
          userId: job.user_id,
          runId: job.id,
          errorMessage: 'Dataset has no eval cases',
          durationMs: Date.now() - startedAt,
          workerId: job.worker_id || this.workerId,
          leaseToken: job.lease_token,
        });
        if (failedRun) metrics.recordRagEvalRunCompleted('failed');
        return;
      }

      const output = await executeRagEvalRequest(job, {
        registerController: (runId, leaseToken, controller) => (
          this.registerController(runId, leaseToken, controller)
        ),
      });

      const completedRun = await completeRagEvalRunWithResults({
        userId: job.user_id,
        runId: job.id,
        workerId: job.worker_id || this.workerId,
        leaseToken: job.lease_token,
        output,
      });

      if (completedRun && completedRun.status !== 'running') {
        metrics.recordRagEvalRunCompleted(completedRun.status);
      }
    } catch (error) {
      console.warn('[RagEvalQueue] Evaluation request failed:', toSafeError(error));
      const failedRun = await markRagEvalRunAttemptFailed({
        run: job,
        errorMessage: 'RAG evaluation failed',
        durationMs: Date.now() - startedAt,
        workerId: job.worker_id || this.workerId,
        leaseToken: job.lease_token,
      });

      if (!failedRun) return;
      if (failedRun.status === 'failed') {
        metrics.recordRagEvalRunCompleted('failed');
      } else {
        metrics.recordRagEvalRunRetried();
      }
    }
  }
}

export const ragEvalQueue = new RagEvalQueueService();

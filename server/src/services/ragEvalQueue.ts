import os from 'os';
import { serverEnv } from '../lib/env';
import { metrics } from '../lib/metrics';
import { runRagEvaluation } from '../lib/ragClient';
import { toSafeError } from '../lib/safeError';
import {
  ClaimedRagEvalRunJob,
  completeRagEvalRunWithResults,
  failRagEvalRunForUser,
  markRagEvalRunAttemptFailed,
  claimNextRagEvalRunJob,
  RagEvalDatasetRow,
} from '../repositories/ragEval';

const toRagEvalCases = (dataset: RagEvalDatasetRow) => (dataset.cases || []).map((testCase) => ({
  id: testCase.id,
  question: testCase.question,
  expected_answer: testCase.expected_answer,
  expected_keywords: testCase.expected_keywords,
  expected_source_files: testCase.expected_source_files,
}));

class RagEvalQueueService {
  private isProcessing = false;
  private interval: NodeJS.Timeout | null = null;
  private workerId = `${os.hostname()}:${process.pid}:rag-eval`;
  private intervalMs = serverEnv.RAG_EVAL_QUEUE_INTERVAL_MS;
  private concurrency = serverEnv.RAG_EVAL_QUEUE_CONCURRENCY;

  start() {
    if (this.interval) return;
    this.processPendingBatch();
    this.interval = setInterval(() => this.processPendingBatch(), this.intervalMs);
  }

  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
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
        const jobs: ClaimedRagEvalRunJob[] = [];

        for (let index = 0; index < this.concurrency; index += 1) {
          const job = await claimNextRagEvalRunJob({
            workerId: this.workerId,
            maxAttempts: serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS,
            retryBaseDelayMs: serverEnv.RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS,
            staleAfterMs: serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS,
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
        });
        if (failedRun) metrics.recordRagEvalRunCompleted('failed');
        return;
      }

      const output = await runRagEvaluation({
        user_id: job.user_id,
        project_space_id: job.dataset.project_space_id,
        cases: toRagEvalCases(job.dataset),
        limit: 10,
        threshold: 0.1,
      });

      const completedRun = await completeRagEvalRunWithResults({
        userId: job.user_id,
        runId: job.id,
        workerId: job.worker_id || this.workerId,
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

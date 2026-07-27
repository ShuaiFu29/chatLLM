import os from 'os';
import { Queue, Worker } from 'bullmq';
import { serverEnv } from '../lib/env';
import { metrics } from '../lib/metrics';
import {
  RagEvalRunInput,
  RagEvalRunResponse,
  runRagEvaluation,
} from '../lib/ragClient';
import { BULLMQ_PREFIX, getBullMqConnectionOptions } from '../lib/redis';
import { toSafeError } from '../lib/safeError';
import { generateEvaluatedRagAnswer } from './answerGeneration';
import {
  ClaimedRagEvalRunJob,
  completeRagEvalRunWithResults,
  failRagEvalRunForUser,
  markRagEvalRunAttemptFailed,
  claimRagEvalRunJobById,
  listDispatchableRagEvalRunIds,
  RagEvalDatasetRow,
  renewRagEvalRunLease,
} from '../repositories/ragEval';

export const RAG_EVAL_QUEUE_NAME = 'chatllm-rag-evaluation-v1';
const RAG_EVAL_JOB_NAME = 'run-evaluation';

export interface RagEvalQueuePayload {
  runId: string;
}

export const buildRagEvalQueueJob = (runId: string) => ({
  name: RAG_EVAL_JOB_NAME,
  data: { runId } satisfies RagEvalQueuePayload,
  opts: {
    jobId: `eval-${runId}`,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  },
});

const toRagEvalCases = (dataset: RagEvalDatasetRow) => (dataset.cases || []).map((testCase) => ({
  id: testCase.id,
  question: testCase.question,
  expected_answer: testCase.expected_answer,
  expected_keywords: testCase.expected_keywords,
  expected_source_files: testCase.expected_source_files,
  evaluation_spec: testCase.evaluation_spec || {},
}));

type GenerateEvaluatedAnswer = typeof generateEvaluatedRagAnswer;

export const prepareRagEvalCases = async (
  job: ClaimedRagEvalRunJob,
  signal: AbortSignal,
  generateAnswer: GenerateEvaluatedAnswer = generateEvaluatedRagAnswer,
) => {
  const cases = toRagEvalCases(job.dataset);
  const generatedCases: RagEvalRunInput['cases'] = [];
  for (const testCase of cases) {
    if (signal.aborted) throw new Error('RAG evaluation answer generation aborted');
    const caseController = new AbortController();
    const abortCase = () => caseController.abort();
    signal.addEventListener('abort', abortCase, { once: true });
    const caseTimer = setTimeout(abortCase, job.case_timeout_ms);
    try {
      const generated = await generateAnswer({
        question: testCase.question,
        userId: job.user_id,
        projectSpaceId: job.dataset.project_space_id || undefined,
        temperature: 0,
        signal: caseController.signal,
      });
      const contextStep = generated.prepared.traceSummary.trace_steps.find(
        (step) => step.step_type === 'answer_context_pack',
      );
      generatedCases.push({
        ...testCase,
        actual_answer: generated.actualAnswer,
        retrieval_snapshot: {
          ...generated.prepared.ragRun,
          actual_answer: generated.actualAnswer,
          answer_sources: generated.prepared.answerContextDocuments,
        },
        answer_evaluation: generated.claimEvaluation,
        generation_metadata: {
          prompt_version: generated.promptVersion,
          model_version: generated.modelVersion,
          provider: generated.provider,
          verifier_version: generated.claimEvaluation.verifier_version,
          context_budget_tokens: contextStep?.input?.budget_tokens,
          context_estimated_tokens: contextStep?.output?.estimated_tokens,
          context_truncated: contextStep?.output?.truncated,
          token_usage: generated.tokenUsage,
        },
      });
    } catch {
      if (signal.aborted) throw new Error('RAG evaluation answer generation aborted');
      generatedCases.push({
        ...testCase,
        preparation_error: caseController.signal.aborted
          ? 'Answer generation case timeout'
          : 'Answer generation failed',
      });
    } finally {
      clearTimeout(caseTimer);
      signal.removeEventListener('abort', abortCase);
    }
  }
  return generatedCases;
};

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
  prepareCases?: (
    job: ClaimedRagEvalRunJob,
    signal: AbortSignal,
  ) => Promise<RagEvalRunInput['cases']>;
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
  const deadlineTimer = setTimeout(
    () => controller.abort(),
    Math.min(remainingMs, 2_147_483_647),
  );

  try {
    const cases = options.prepareCases
      ? await options.prepareCases(job, controller.signal)
      : await prepareRagEvalCases(job, controller.signal);
    const transportRemainingMs = Math.floor(new Date(deadlineAt).getTime() - now());
    if (transportRemainingMs <= 0) throw new Error('RAG evaluation deadline exceeded');
    return await runEvaluation({
      run_id: job.id,
      lease_token: job.lease_token,
      deadline_at: deadlineAt,
      case_timeout_ms: job.case_timeout_ms,
      user_id: job.user_id,
      project_space_id: job.dataset.project_space_id,
      cases,
      limit: 10,
      threshold: 0.1,
    }, controller.signal, transportRemainingMs);
  } finally {
    clearTimeout(deadlineTimer);
    try {
      await stopHeartbeat();
    } catch (error) {
      warn('[RagEvalQueue] Failed to stop evaluation heartbeat cleanly:', error);
    }
    unregisterController();
  }
};

class RagEvalQueueService {
  private isDispatching = false;
  private interval: NodeJS.Timeout | null = null;
  private queue: Queue<RagEvalQueuePayload> | null = null;
  private worker: Worker<RagEvalQueuePayload> | null = null;
  private workerId = `${os.hostname()}:${process.pid}:rag-eval`;
  private intervalMs = serverEnv.RAG_EVAL_QUEUE_INTERVAL_MS;
  private concurrency = serverEnv.RAG_EVAL_QUEUE_CONCURRENCY;
  private activeControllers = new Map<string, {
    leaseToken: string;
    controller: AbortController;
  }>();

  async start() {
    if (this.queue || this.worker) return;
    const connection = getBullMqConnectionOptions();
    this.queue = new Queue(RAG_EVAL_QUEUE_NAME, {
      connection,
      prefix: BULLMQ_PREFIX,
    });
    this.worker = new Worker(
      RAG_EVAL_QUEUE_NAME,
      async (job) => this.processRunById(job.data.runId),
      {
        connection,
        prefix: BULLMQ_PREFIX,
        concurrency: this.concurrency,
      },
    );
    this.worker.on('error', (error) => {
      console.error('[RagEvalQueue] BullMQ worker error:', toSafeError(error));
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
    for (const active of this.activeControllers.values()) active.controller.abort();
    this.activeControllers.clear();
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

  private async dispatchPending() {
    if (this.isDispatching || !this.queue) return;
    this.isDispatching = true;

    try {
      const runIds = await listDispatchableRagEvalRunIds(Math.max(20, this.concurrency * 10));
      if (runIds.length > 0) {
        await this.queue.addBulk(runIds.map(buildRagEvalQueueJob));
      }
    } catch (error) {
      console.error('[RagEvalQueue] Failed to dispatch queued eval runs:', toSafeError(error));
    } finally {
      this.isDispatching = false;
    }
  }

  private async processRunById(runId: string) {
    const job = await claimRagEvalRunJobById(runId, {
      workerId: this.workerId,
      maxAttempts: serverEnv.RAG_EVAL_QUEUE_MAX_ATTEMPTS,
      retryBaseDelayMs: serverEnv.RAG_EVAL_QUEUE_RETRY_BASE_DELAY_MS,
      staleAfterMs: serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS,
      runTimeoutMs: serverEnv.RAG_EVAL_RUN_TIMEOUT_MS,
    });
    if (!job) return;
    metrics.recordRagEvalRunQueueClaimed();
    await this.processRun(job);
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

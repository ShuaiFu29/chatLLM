import os from 'os';
import { Queue, Worker } from 'bullmq';
import { serverEnv } from '../lib/env';
import { BULLMQ_PREFIX, getBullMqConnectionOptions } from '../lib/redis';
import { toSafeError } from '../lib/safeError';
import {
  addAgentEvalUsage,
  aggregateAgentEvalResults,
  emptyAgentTokenUsage,
  executeAgentEvalVariant,
} from '../modules/agent-eval/agent-eval-runtime';
import { AgentsService } from '../modules/agents/agents.service';
import {
  type AgentEvalResultInput,
  type ClaimedAgentEvalRun,
  claimAgentEvalRunJobById,
  completeAgentEvalRun,
  listDispatchableAgentEvalRunIds,
  markAgentEvalRunAttemptFailed,
  renewAgentEvalRunLease,
  isAgentEvalRunClaimActive,
} from '../repositories/agentEval';

export const AGENT_EVAL_QUEUE_NAME = 'chatllm-agent-evaluation-v1';
const AGENT_EVAL_JOB_NAME = 'run-agent-evaluation';

export interface AgentEvalQueuePayload {
  runId: string;
}

export const buildAgentEvalQueueJob = (runId: string) => ({
  name: AGENT_EVAL_JOB_NAME,
  data: { runId } satisfies AgentEvalQueuePayload,
  opts: {
    jobId: `agent-eval-${runId}`,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  },
});

export const buildFailedAgentEvalMetrics = (failureCode: string) => ({
  task_success: 0,
  overall_score: 0,
  output_expectation_score: 0,
  output_schema_validity: 0,
  tool_selection_score: 0,
  tool_argument_validity: 0,
  tool_argument_correctness: 0,
  safety_score: null,
  safety_violation_count: 0,
  groundedness_score: null,
  citation_quality_score: null,
  metric_applicability: {
    output_expectations: false,
    tool_selection: false,
    tool_arguments: false,
    safety: false,
    groundedness: false,
    citations: false,
    cost: false,
  },
  failure_code: failureCode,
});

const classifyVariantFailure = (error: unknown) => {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { code: 'agent_eval_case_timeout', message: 'Agent evaluation case exceeded its deadline' };
  }
  if (name === 'AgentOutputValidationError') {
    return { code: 'output_validation_failed', message: 'Agent output did not match its configured contract' };
  }
  if (name === 'AgentProtocolError') {
    return { code: 'model_protocol_error', message: 'Model returned an invalid Agent protocol response' };
  }
  return { code: 'agent_eval_case_failed', message: 'Agent evaluation case failed' };
};

type PinnedEvalAgent = Awaited<ReturnType<AgentsService['getVersionForDryRun']>>['agent'];

const runVariant = async (input: {
  agent: PinnedEvalAgent;
  job: ClaimedAgentEvalRun;
  testCase: ClaimedAgentEvalRun['cases'][number];
  variant: 'candidate' | 'baseline';
  signal: AbortSignal;
  runSignal: AbortSignal;
}): Promise<AgentEvalResultInput> => {
  const versionId = input.variant === 'candidate'
    ? input.job.candidate_agent_version_id
    : input.job.baseline_agent_version_id!;
  const expectedHash = input.variant === 'candidate'
    ? input.job.candidate_configuration_hash
    : input.job.baseline_configuration_hash!;
  const startedAt = Date.now();
  try {
    const result = await executeAgentEvalVariant({
      userId: input.job.user_id,
      agent: input.agent,
      question: input.testCase.input_text,
      evaluationSpec: input.testCase.evaluation_spec,
      signal: input.signal,
    });
    return {
      caseId: input.testCase.case_id,
      variant: input.variant,
      agentId: input.job.agent_id,
      agentVersionId: versionId,
      configurationHash: expectedHash,
      status: 'succeeded',
      outputText: result.output,
      plannedToolCalls: result.planned_tool_calls,
      metrics: result.metrics,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  } catch (error) {
    if (input.runSignal.aborted) throw error;
    const failure = classifyVariantFailure(error);
    return {
      caseId: input.testCase.case_id,
      variant: input.variant,
      agentId: input.job.agent_id,
      agentVersionId: versionId,
      configurationHash: expectedHash,
      status: 'failed',
      outputText: '',
      plannedToolCalls: [],
      metrics: buildFailedAgentEvalMetrics(failure.code),
      usage: emptyAgentTokenUsage(),
      latencyMs: Math.max(0, Date.now() - startedAt),
      failureCode: failure.code,
      failureMessage: failure.message,
    };
  }
};

export const executeClaimedAgentEvalRun = async (input: {
  job: ClaimedAgentEvalRun;
  agentsService?: AgentsService;
  signal: AbortSignal;
}) => {
  const agentsService = input.agentsService || new AgentsService();
  const [candidatePinned, baselinePinned] = await Promise.all([
    agentsService.getVersionForDryRun(
      input.job.user_id,
      input.job.agent_id,
      input.job.candidate_agent_version_id,
    ),
    input.job.baseline_agent_version_id
      ? agentsService.getVersionForDryRun(
        input.job.user_id,
        input.job.agent_id,
        input.job.baseline_agent_version_id,
      )
      : Promise.resolve(null),
  ]);
  if (
    !candidatePinned.validationReport.valid
    || candidatePinned.agent.configuration_hash !== input.job.candidate_configuration_hash
    || (baselinePinned && (
      !baselinePinned.validationReport.valid
      || baselinePinned.agent.configuration_hash !== input.job.baseline_configuration_hash
    ))
  ) throw new Error('Pinned Agent evaluation version is no longer valid');
  const results: AgentEvalResultInput[] = [];
  const usage = emptyAgentTokenUsage();
  for (const testCase of input.job.cases) {
    input.signal.throwIfAborted();
    const variantSignal = () => AbortSignal.any([
      input.signal,
      AbortSignal.timeout(Math.min(120_000, Math.max(1, serverEnv.RAG_EVAL_CASE_TIMEOUT_MS))),
    ]);
    const candidate = await runVariant({
      agent: candidatePinned.agent,
      job: input.job,
      testCase,
      variant: 'candidate',
      signal: variantSignal(),
      runSignal: input.signal,
    });
    results.push(candidate);
    addAgentEvalUsage(usage, candidate.usage);
    if (input.job.baseline_agent_version_id) {
      const baseline = await runVariant({
        agent: baselinePinned!.agent,
        job: input.job,
        testCase,
        variant: 'baseline',
        signal: variantSignal(),
        runSignal: input.signal,
      });
      results.push(baseline);
      addAgentEvalUsage(usage, baseline.usage);
    }
  }
  const candidateResults = results.filter((result) => result.variant === 'candidate');
  const candidateSuccesses = candidateResults.filter((result) => result.status === 'succeeded').length;
  const failedCount = results.filter((result) => result.status === 'failed').length;
  const status = candidateSuccesses === 0
    ? 'failed' as const
    : failedCount > 0
      ? 'partial' as const
      : 'completed' as const;
  return {
    status,
    results,
    usage,
    aggregateMetrics: aggregateAgentEvalResults({
      results,
      caseCount: input.job.case_count,
      hasBaseline: Boolean(input.job.baseline_agent_version_id),
    }),
  };
};

class AgentEvalQueueService {
  private queue: Queue<AgentEvalQueuePayload> | null = null;
  private worker: Worker<AgentEvalQueuePayload> | null = null;
  private interval: NodeJS.Timeout | null = null;
  private dispatching = false;
  private readonly workerId = `${os.hostname()}:${process.pid}:agent-eval`;
  private readonly activeControllers = new Map<string, AbortController>();

  async start() {
    if (this.queue || this.worker) return;
    const connection = getBullMqConnectionOptions();
    this.queue = new Queue(AGENT_EVAL_QUEUE_NAME, { connection, prefix: BULLMQ_PREFIX });
    this.worker = new Worker(
      AGENT_EVAL_QUEUE_NAME,
      async (job) => this.processRunById(job.data.runId),
      {
        connection,
        prefix: BULLMQ_PREFIX,
        concurrency: Math.max(1, Math.min(2, serverEnv.RAG_EVAL_QUEUE_CONCURRENCY)),
      },
    );
    this.worker.on('error', (error) => {
      console.error('[AgentEvalQueue] BullMQ worker error:', toSafeError(error));
    });
    await Promise.all([this.queue.waitUntilReady(), this.worker.waitUntilReady()]);
    await this.dispatchPending();
    this.interval = setInterval(() => this.dispatchPending(), serverEnv.RAG_EVAL_QUEUE_INTERVAL_MS);
    this.interval.unref();
  }

  async stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const controller of this.activeControllers.values()) controller.abort();
    this.activeControllers.clear();
    const queue = this.queue;
    const worker = this.worker;
    this.queue = null;
    this.worker = null;
    await worker?.close();
    await queue?.close();
  }

  trigger() {
    void this.dispatchPending();
  }

  abortRun(runId: string) {
    const controller = this.activeControllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async dispatchPending() {
    if (this.dispatching || !this.queue) return;
    this.dispatching = true;
    try {
      const runIds = await listDispatchableAgentEvalRunIds(50);
      if (runIds.length > 0) await this.queue.addBulk(runIds.map(buildAgentEvalQueueJob));
    } catch (error) {
      console.error('[AgentEvalQueue] Failed to dispatch evaluations:', toSafeError(error));
    } finally {
      this.dispatching = false;
    }
  }

  private async processRunById(runId: string) {
    const job = await claimAgentEvalRunJobById({
      runId,
      workerId: this.workerId,
      leaseDurationMs: serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS,
      runTimeoutMs: serverEnv.RAG_EVAL_RUN_TIMEOUT_MS,
    });
    if (!job) return;
    const controller = new AbortController();
    this.activeControllers.set(job.id, controller);
    const heartbeatMs = Math.max(1000, Math.floor(serverEnv.RAG_EVAL_QUEUE_STALE_AFTER_MS / 4));
    const heartbeat = setInterval(() => {
      void Promise.all([
        renewAgentEvalRunLease({
          runId: job.id,
          workerId: job.worker_id,
          leaseToken: job.lease_token,
        }),
        isAgentEvalRunClaimActive({
          runId: job.id,
          workerId: job.worker_id,
          leaseToken: job.lease_token,
        }),
      ]).then(([renewed, active]) => {
        if (!renewed || !active) controller.abort();
      }).catch(() => controller.abort());
    }, Math.min(heartbeatMs, 1000));
    heartbeat.unref();
    const remainingMs = Math.max(1, new Date(job.deadline_at).getTime() - Date.now());
    const deadline = setTimeout(() => controller.abort(), Math.min(remainingMs, 2_147_483_647));
    try {
      const output = await executeClaimedAgentEvalRun({ job, signal: controller.signal });
      await completeAgentEvalRun({
        runId: job.id,
        userId: job.user_id,
        workerId: job.worker_id,
        leaseToken: job.lease_token,
        status: output.status,
        aggregateMetrics: output.aggregateMetrics,
        usage: output.usage,
        results: output.results,
        failureCode: output.status === 'failed' ? 'all_candidate_cases_failed' : undefined,
        failureMessage: output.status === 'failed'
          ? 'Every candidate Agent evaluation case failed'
          : undefined,
      });
    } catch (error) {
      console.warn('[AgentEvalQueue] Evaluation attempt failed:', toSafeError(error));
      await markAgentEvalRunAttemptFailed({
        run: job,
        workerId: job.worker_id,
        leaseToken: job.lease_token,
        errorMessage: 'Agent evaluation worker failed',
      });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      if (this.activeControllers.get(job.id) === controller) this.activeControllers.delete(job.id);
    }
  }
}

export const agentEvalQueue = new AgentEvalQueueService();

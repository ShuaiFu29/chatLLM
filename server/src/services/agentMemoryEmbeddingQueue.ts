import os from 'node:os';
import { Queue, Worker } from 'bullmq';
import { serverEnv } from '../lib/env';
import { embedTexts } from '../lib/ragClient';
import { BULLMQ_PREFIX, getBullMqConnectionOptions } from '../lib/redis';
import { toSafeError } from '../lib/safeError';
import {
  claimAgentMemoryEmbeddingJobById,
  completeAgentMemoryEmbeddingJob,
  failAgentMemoryEmbeddingAttempt,
  listDispatchableAgentMemoryEmbeddingIds,
  reconcileInactiveAgentMemoryEmbeddingJobs,
  renewAgentMemoryEmbeddingLease,
  type ClaimedAgentMemoryEmbeddingJob,
} from '../repositories/agentMemoryEmbeddings';

export const AGENT_MEMORY_EMBEDDING_QUEUE_NAME = 'chatllm-agent-memory-embedding-v1';
const AGENT_MEMORY_EMBEDDING_JOB_NAME = 'embed-agent-memory';

export interface AgentMemoryEmbeddingQueuePayload {
  memoryId: string;
}

export const buildAgentMemoryEmbeddingQueueJob = (memoryId: string) => ({
  name: AGENT_MEMORY_EMBEDDING_JOB_NAME,
  data: { memoryId } satisfies AgentMemoryEmbeddingQueuePayload,
  opts: {
    jobId: `agent-memory-embedding-${memoryId}`,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  },
});

type AgentMemoryEmbeddingQueueWriter = Pick<
  Queue<AgentMemoryEmbeddingQueuePayload>,
  'addBulk'
>;

export const dispatchAgentMemoryEmbeddingJobs = async (
  queue: AgentMemoryEmbeddingQueueWriter,
  limit = 100,
  dependencies: {
    listIds?: typeof listDispatchableAgentMemoryEmbeddingIds;
    reconcile?: typeof reconcileInactiveAgentMemoryEmbeddingJobs;
  } = {},
) => {
  const reconcile = dependencies.reconcile ?? reconcileInactiveAgentMemoryEmbeddingJobs;
  const listIds = dependencies.listIds ?? listDispatchableAgentMemoryEmbeddingIds;
  await reconcile();
  const ids = await listIds(limit);
  if (ids.length > 0) await queue.addBulk(ids.map(buildAgentMemoryEmbeddingQueueJob));
  return ids;
};

type EmbeddingResponse = Awaited<ReturnType<typeof embedTexts>>;

const waitForEmbedding = (
  load: () => Promise<EmbeddingResponse>,
  signal: AbortSignal,
) => new Promise<EmbeddingResponse>((resolve, reject) => {
  if (signal.aborted) {
    reject(signal.reason ?? new Error('Agent Memory embedding aborted'));
    return;
  }
  const onAbort = () => {
    signal.removeEventListener('abort', onAbort);
    reject(signal.reason ?? new Error('Agent Memory embedding aborted'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  Promise.resolve().then(load).then(
    (value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    },
    (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    },
  );
});

interface ExecuteAgentMemoryEmbeddingOptions {
  embed?: typeof embedTexts;
  complete?: typeof completeAgentMemoryEmbeddingJob;
  fail?: typeof failAgentMemoryEmbeddingAttempt;
  renew?: typeof renewAgentMemoryEmbeddingLease;
  timeoutMs?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  warn?: (message: string, error: unknown) => void;
}

const defaultWarn = (message: string, error: unknown) => {
  console.warn(message, toSafeError(error));
};

const startEmbeddingLeaseHeartbeat = (
  claim: ClaimedAgentMemoryEmbeddingJob,
  controller: AbortController,
  input: {
    renew: typeof renewAgentMemoryEmbeddingLease;
    leaseDurationMs: number;
    warn: (message: string, error: unknown) => void;
  },
) => {
  const intervalMs = Math.max(100, Math.floor(input.leaseDurationMs / 4));
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(run, intervalMs);
    timer.unref();
  };
  const run = () => {
    timer = null;
    inFlight = input.renew({
      memoryId: claim.memory_id,
      workerId: claim.worker_id,
      leaseToken: claim.lease_token,
      leaseDurationMs: input.leaseDurationMs,
    }).then((leaseExpiresAt) => {
      if (leaseExpiresAt) return;
      stopped = true;
      controller.abort(new Error('Agent Memory embedding lease lost'));
    }).catch((error) => {
      stopped = true;
      input.warn('[AgentMemoryEmbeddingQueue] Lease renewal failed:', error);
      controller.abort(new Error('Agent Memory embedding lease renewal failed'));
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

export const executeAgentMemoryEmbedding = async (
  claim: ClaimedAgentMemoryEmbeddingJob,
  options: ExecuteAgentMemoryEmbeddingOptions = {},
) => {
  const embed = options.embed ?? embedTexts;
  const complete = options.complete ?? completeAgentMemoryEmbeddingJob;
  const fail = options.fail ?? failAgentMemoryEmbeddingAttempt;
  const renew = options.renew ?? renewAgentMemoryEmbeddingLease;
  const timeoutMs = options.timeoutMs ?? serverEnv.AGENT_MEMORY_EMBEDDING_TIMEOUT_MS;
  const leaseDurationMs = options.leaseDurationMs
    ?? serverEnv.AGENT_MEMORY_EMBEDDING_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? serverEnv.AGENT_MEMORY_EMBEDDING_MAX_ATTEMPTS;
  const retryBaseDelayMs = options.retryBaseDelayMs
    ?? serverEnv.AGENT_MEMORY_EMBEDDING_RETRY_BASE_DELAY_MS;
  const warn = options.warn ?? defaultWarn;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Agent Memory embedding timed out'));
  }, timeoutMs);
  timeout.unref();
  const stopHeartbeat = startEmbeddingLeaseHeartbeat(claim, controller, {
    renew,
    leaseDurationMs,
    warn,
  });

  try {
    const response = await waitForEmbedding(
      () => embed([claim.content], controller.signal),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const vector = response.embeddings[0];
    if (!Array.isArray(vector) || vector.length === 0 || !response.model) {
      throw new Error('Embedding provider returned no usable vector');
    }
    return await complete({
      memoryId: claim.memory_id,
      userId: claim.user_id,
      workerId: claim.worker_id,
      leaseToken: claim.lease_token,
      embedding: { vector, model: response.model },
    });
  } catch (error) {
    const errorCode = timedOut
      ? 'embedding_timeout'
      : controller.signal.aborted
        ? 'embedding_lease_lost'
        : 'embedding_provider_unavailable';
    await fail({
      memoryId: claim.memory_id,
      userId: claim.user_id,
      workerId: claim.worker_id,
      leaseToken: claim.lease_token,
      maxAttempts,
      retryBaseDelayMs,
      errorCode,
    });
    warn('[AgentMemoryEmbeddingQueue] Embedding attempt failed:', error);
    return false;
  } finally {
    clearTimeout(timeout);
    await stopHeartbeat();
  }
};

class AgentMemoryEmbeddingQueueService {
  private queue: Queue<AgentMemoryEmbeddingQueuePayload> | null = null;
  private worker: Worker<AgentMemoryEmbeddingQueuePayload> | null = null;
  private interval: NodeJS.Timeout | null = null;
  private dispatching = false;
  private readonly workerId = `${os.hostname()}:${process.pid}:agent-memory-embedding`;

  async start() {
    if (this.queue || this.worker) return;
    const connection = getBullMqConnectionOptions();
    this.queue = new Queue(AGENT_MEMORY_EMBEDDING_QUEUE_NAME, {
      connection,
      prefix: BULLMQ_PREFIX,
    });
    this.worker = new Worker(
      AGENT_MEMORY_EMBEDDING_QUEUE_NAME,
      async (job) => this.processMemoryById(job.data.memoryId),
      {
        connection,
        prefix: BULLMQ_PREFIX,
        concurrency: serverEnv.AGENT_MEMORY_EMBEDDING_QUEUE_CONCURRENCY,
      },
    );
    this.worker.on('error', (error) => {
      console.error('[AgentMemoryEmbeddingQueue] BullMQ worker error:', toSafeError(error));
    });
    await Promise.all([this.queue.waitUntilReady(), this.worker.waitUntilReady()]);
    await this.dispatchPending();
    this.interval = setInterval(
      () => this.dispatchPending(),
      serverEnv.AGENT_MEMORY_EMBEDDING_QUEUE_INTERVAL_MS,
    );
    this.interval.unref();
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
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

  private async dispatchPending() {
    if (this.dispatching || !this.queue) return;
    this.dispatching = true;
    try {
      await dispatchAgentMemoryEmbeddingJobs(this.queue);
    } catch (error) {
      console.error('[AgentMemoryEmbeddingQueue] Failed to dispatch jobs:', toSafeError(error));
    } finally {
      this.dispatching = false;
    }
  }

  private async processMemoryById(memoryId: string) {
    const claim = await claimAgentMemoryEmbeddingJobById({
      memoryId,
      workerId: this.workerId,
      leaseDurationMs: serverEnv.AGENT_MEMORY_EMBEDDING_LEASE_MS,
      maxAttempts: serverEnv.AGENT_MEMORY_EMBEDDING_MAX_ATTEMPTS,
    });
    if (!claim) return false;
    return executeAgentMemoryEmbedding(claim);
  }
}

export const agentMemoryEmbeddingQueue = new AgentMemoryEmbeddingQueueService();

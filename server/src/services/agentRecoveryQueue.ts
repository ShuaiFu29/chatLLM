import { Queue, Worker } from 'bullmq';
import { serverEnv } from '../lib/env';
import { BULLMQ_PREFIX, getBullMqConnectionOptions } from '../lib/redis';
import { toSafeError } from '../lib/safeError';
import { recoverAgentWorkItem } from '../modules/agents/runtime/agent-runtime-recovery';
import {
  listRecoverableExpiredAgentWorkItemIds,
  listRecoverableQueuedAgentWorkItemIds,
} from '../repositories/agentWorkItems';

export const AGENT_RECOVERY_QUEUE_NAME = 'chatllm-agent-recovery-v1';
const AGENT_RECOVERY_JOB_NAME = 'recover-agent-work-item';
const AGENT_RECOVERY_CONCURRENCY = 4;
const AGENT_RECOVERY_INTERVAL_MS = 5_000;

export interface AgentRecoveryQueuePayload {
  workItemId: string;
}

/** BullMQ is delivery only; PostgreSQL remains the source of execution truth. */
export const buildAgentRecoveryQueueJob = (workItemId: string) => ({
  name: AGENT_RECOVERY_JOB_NAME,
  data: { workItemId } satisfies AgentRecoveryQueuePayload,
  opts: {
    jobId: `agent-recovery-${workItemId}`,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  },
});

type AgentRecoveryQueueWriter = Pick<Queue<AgentRecoveryQueuePayload>, 'addBulk'>;

/**
 * Rebuild queue delivery exclusively from durable PostgreSQL state. Keeping
 * this edge independent from the service timer makes Redis-loss recovery both
 * reusable at startup and verifiable against real infrastructure.
 */
export const dispatchRecoverableAgentWorkItems = async (
  queue: AgentRecoveryQueueWriter,
  limit = 100,
) => {
  const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const [queuedIds, expiredIds] = await Promise.all([
    listRecoverableQueuedAgentWorkItemIds(safeLimit),
    listRecoverableExpiredAgentWorkItemIds(safeLimit),
  ]);
  const ids = [...new Set([...queuedIds, ...expiredIds])].slice(0, safeLimit);
  if (ids.length > 0) await queue.addBulk(ids.map(buildAgentRecoveryQueueJob));
  return ids;
};

class AgentRecoveryQueueService {
  private queue: Queue<AgentRecoveryQueuePayload> | null = null;
  private worker: Worker<AgentRecoveryQueuePayload> | null = null;
  private interval: NodeJS.Timeout | null = null;
  private dispatching = false;

  async start() {
    if (this.queue || this.worker) return;
    const connection = getBullMqConnectionOptions();
    this.queue = new Queue(AGENT_RECOVERY_QUEUE_NAME, { connection, prefix: BULLMQ_PREFIX });
    this.worker = new Worker(
      AGENT_RECOVERY_QUEUE_NAME,
      async (job) => recoverAgentWorkItem({
        workItemId: job.data.workItemId,
        leaseDurationMs: serverEnv.AGENT_SUBAGENT_LEASE_MS,
      }),
      {
        connection,
        prefix: BULLMQ_PREFIX,
        concurrency: AGENT_RECOVERY_CONCURRENCY,
      },
    );
    this.worker.on('error', (error) => {
      console.error('[AgentRecoveryQueue] BullMQ worker error:', toSafeError(error));
    });
    await Promise.all([this.queue.waitUntilReady(), this.worker.waitUntilReady()]);
    await this.dispatchRecoverableWork();
    this.interval = setInterval(
      () => this.dispatchRecoverableWork(),
      AGENT_RECOVERY_INTERVAL_MS,
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
    void this.dispatchRecoverableWork();
  }

  private async dispatchRecoverableWork() {
    if (this.dispatching || !this.queue) return;
    this.dispatching = true;
    try {
      await dispatchRecoverableAgentWorkItems(this.queue);
    } catch (error) {
      console.error('[AgentRecoveryQueue] Failed to dispatch recovery work:', toSafeError(error));
    } finally {
      this.dispatching = false;
    }
  }
}

export const agentRecoveryQueue = new AgentRecoveryQueueService();

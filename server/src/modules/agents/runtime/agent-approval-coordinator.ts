import {
  expireAgentApproval,
  findAgentApprovalForUser,
} from '../../../repositories/agentRuns';
import type { AgentApprovalIntent } from './agent-approval-intent';

export interface AgentApprovalResolution {
  decision: 'approved' | 'rejected' | 'expired';
  reason: string;
}

export class AgentApprovalExpiredError extends Error {
  constructor(message = 'Agent approval expired') {
    super(message);
    this.name = 'AgentApprovalExpiredError';
  }
}

export interface AgentApprovalLedger {
  find: typeof findAgentApprovalForUser;
  expire: typeof expireAgentApproval;
}

export type AgentApprovalRecoveryDecision =
  | { kind: 'pending'; approvalId: string; expiresAt: string }
  | {
    kind: 'resolved';
    decision: AgentApprovalResolution['decision'];
    reason: string;
    intent: AgentApprovalIntent;
    intentHash: string;
  }
  | { kind: 'stop'; reason: 'approval_missing' | 'approval_scope_mismatch' };

/** Database-authoritative approval reconciliation used after a worker loss. */
export const reconcileAgentApprovalForRecovery = async (input: {
  approvalId: string;
  surfaceRunId: string;
  requestingRunId: string;
  userId: string;
  now?: number;
  ledger?: AgentApprovalLedger;
}): Promise<AgentApprovalRecoveryDecision> => {
  const ledger = input.ledger || postgresApprovalLedger;
  let approval = await ledger.find(input.approvalId, input.surfaceRunId, input.userId);
  if (!approval) return { kind: 'stop', reason: 'approval_missing' };
  const expectedRequester = input.requestingRunId === input.surfaceRunId
    ? null
    : input.requestingRunId;
  if ((approval.requested_by_run_id || null) !== expectedRequester) {
    return { kind: 'stop', reason: 'approval_scope_mismatch' };
  }
  if (approval.status === 'pending' && new Date(approval.expires_at).getTime() <= (input.now ?? Date.now())) {
    approval = await ledger.expire(input.approvalId, input.surfaceRunId) || approval;
  }
  if (approval.status === 'pending') {
    return { kind: 'pending', approvalId: approval.id, expiresAt: approval.expires_at };
  }
  return {
    kind: 'resolved',
    decision: approval.status,
    reason: approval.reason || '',
    intent: approval.intent,
    intentHash: approval.intent_hash,
  };
};

interface PendingAgentApproval {
  runId: string;
  userId: string;
  resolve(value: AgentApprovalResolution): void;
  reject(error: Error): void;
}

const postgresApprovalLedger: AgentApprovalLedger = {
  find: findAgentApprovalForUser,
  expire: expireAgentApproval,
};

/**
 * Shared approval wait state machine for root and delegated Agents.
 *
 * Approval creation and UI events remain adapter concerns. The coordinator owns
 * cross-process polling, same-process wake-up, identity checks, expiry, abort and
 * cleanup so a child cannot accidentally receive weaker wait semantics.
 */
export class AgentApprovalCoordinator {
  private readonly pending = new Map<string, PendingAgentApproval>();

  constructor(private readonly ledger: AgentApprovalLedger = postgresApprovalLedger) {}

  hasPending(approvalId: string, runId: string, userId: string) {
    const pending = this.pending.get(approvalId);
    return Boolean(pending && pending.runId === runId && pending.userId === userId);
  }

  resolve(
    approvalId: string,
    runId: string,
    userId: string,
    resolution: AgentApprovalResolution,
  ) {
    const pending = this.pending.get(approvalId);
    if (!pending || pending.runId !== runId || pending.userId !== userId) return false;
    pending.resolve(resolution);
    return true;
  }

  rejectRun(runId: string, error: Error) {
    for (const [approvalId, pending] of this.pending) {
      if (pending.runId !== runId) continue;
      pending.reject(error);
      this.pending.delete(approvalId);
    }
  }

  wait(input: {
    approvalId: string;
    runId: string;
    userId: string;
    signal: AbortSignal;
    expiresAt?: string;
    pollIntervalMs?: number;
  }) {
    if (this.pending.has(input.approvalId)) {
      return Promise.reject(new Error('Agent approval already has an active waiter'));
    }
    const expiry = input.expiresAt
      ? new Date(input.expiresAt).getTime()
      : Number.MAX_SAFE_INTEGER;
    const deadline = Number.isFinite(expiry) ? expiry : Number.MAX_SAFE_INTEGER;
    const pollIntervalMs = Math.max(25, Math.min(5_000, input.pollIntervalMs ?? 250));

    return new Promise<AgentApprovalResolution>((resolve, reject) => {
      let settled = false;
      let polling = false;
      let pollTimer: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearTimeout(pollTimer);
        input.signal.removeEventListener('abort', onAbort);
        this.pending.delete(input.approvalId);
      };
      const expire = () => this.ledger.expire(input.approvalId, input.runId)
        .catch(() => undefined);
      const onAbort = () => {
        cleanup();
        void expire();
        reject(input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error('Agent approval wait was cancelled'));
      };
      const finish = (resolution: AgentApprovalResolution) => {
        cleanup();
        resolve(resolution);
      };
      const schedulePoll = () => {
        if (settled) return;
        pollTimer = setTimeout(() => {
          void pollApproval();
        }, pollIntervalMs);
      };
      const pollApproval = async () => {
        if (settled || polling) return;
        polling = true;
        try {
          const approval = await this.ledger.find(
            input.approvalId,
            input.runId,
            input.userId,
          );
          if (settled) return;
          if (approval?.status === 'approved' || approval?.status === 'rejected') {
            finish({ decision: approval.status, reason: approval.reason || '' });
            return;
          }
          if (approval?.status === 'expired' || Date.now() >= deadline) {
            await expire();
            if (!settled) finish({ decision: 'expired', reason: approval?.reason || '' });
            return;
          }
        } catch {
          // A transient database failure does not weaken the decision boundary.
          // Keep waiting until the persisted state can be read or the deadline/abort wins.
        } finally {
          polling = false;
          schedulePoll();
        }
      };

      if (input.signal.aborted) {
        onAbort();
        return;
      }
      input.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(input.approvalId, {
        runId: input.runId,
        userId: input.userId,
        reject: (error) => {
          cleanup();
          reject(error);
        },
        resolve: finish,
      });
      schedulePoll();
    });
  }
}

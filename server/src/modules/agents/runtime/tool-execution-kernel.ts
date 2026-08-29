import { randomUUID } from 'node:crypto';
import { serverEnv } from '../../../lib/env';
import {
  beginAgentToolInvocation,
  buildAgentToolIdempotencyKey,
  findAgentToolInvocationForRun,
  finishAgentToolInvocation,
  restoreAgentToolInvocationResult,
  type AgentToolInvocationResultPayload,
  type AgentToolInvocationRow,
} from '../../../repositories/agentToolInvocations';
import type { AgentRuntimeTool, AgentToolExecutionContext } from './agent-tool';
import {
  AgentToolError,
  classifyAgentToolError,
  type ClassifiedAgentToolError,
} from './agent-tool-error';
import { decideAgentToolFailure } from './tool-retry';

export interface AgentToolRetryEvent {
  attempt: number;
  maxAttempts: number;
  retryMode: AgentRuntimeTool['retryMode'];
  error: ClassifiedAgentToolError;
}

export interface AgentToolAttemptEvent {
  attempt: number;
  /** Present when the tool body threw before the adapter settlement hook ran. */
  error?: unknown;
}

export interface ExecuteAgentToolInput {
  tool: AgentRuntimeTool;
  args: unknown;
  context: Omit<AgentToolExecutionContext, 'attempt' | 'idempotencyKey'>;
  maxAttempts?: number;
  /**
   * Return a stable run-level code for cancellation/deadline/resource outcomes.
   * These must escape the tool loop rather than being handed back to the model as
   * an ordinary tool failure.
   */
  classifyRunOutcome?(error: unknown): string | null;
  /** Adapter lifecycle, for example parking a Run before subagent dispatch. */
  beforeAttempt?(event: { attempt: number }): Promise<void> | void;
  /** Runs after both success and failure, so parked state cannot leak. */
  afterAttempt?(event: AgentToolAttemptEvent): Promise<void> | void;
  /** Persist a visible retry Step without coupling the kernel to a Run UI. */
  onRetry?(event: AgentToolRetryEvent): Promise<void> | void;
  /** Exact bounded data used by both the current loop and a recovery worker. */
  serializeResult(result: unknown): AgentToolInvocationResultPayload;
  /** Test/alternate persistence adapter; production uses the PostgreSQL ledger. */
  ledger?: AgentToolExecutionLedger;
}

export interface ExecuteAgentToolResult {
  result: unknown;
  durableResult: AgentToolInvocationResultPayload;
  attempts: number;
  idempotencyKey: string;
}

export type AgentToolInvocationRecoveryDecision =
  | { kind: 'reuse'; result: AgentToolInvocationResultPayload }
  | { kind: 'failed'; errorCode: string }
  | {
    kind: 'stop';
    reason: 'tool_invocation_missing'
      | 'tool_outcome_unknown'
      | 'tool_result_missing';
  };

export type AgentToolBatchRecoveryDecision = AgentToolInvocationRecoveryDecision
  | { kind: 'not_started' };

export interface AgentToolInvocationRecoveryLedger {
  find: typeof findAgentToolInvocationForRun;
}

/** Classify a durable tool row without ever inferring that replay is safe. */
export const decideAgentToolInvocationRecovery = (
  invocation: AgentToolInvocationRow | null,
): AgentToolInvocationRecoveryDecision => {
  if (!invocation) return { kind: 'stop', reason: 'tool_invocation_missing' };
  if (invocation.status === 'succeeded') {
    const result = restoreAgentToolInvocationResult(invocation);
    return result
      ? { kind: 'reuse', result }
      : { kind: 'stop', reason: 'tool_result_missing' };
  }
  if (invocation.status === 'failed') {
    return { kind: 'failed', errorCode: invocation.error_code || 'tool_execution_failed' };
  }
  return { kind: 'stop', reason: 'tool_outcome_unknown' };
};

const postgresToolRecoveryLedger: AgentToolInvocationRecoveryLedger = {
  find: findAgentToolInvocationForRun,
};

/**
 * Reconcile every call from one checkpointed assistant message. A missing row
 * means the call never crossed the invocation-ledger boundary and may be started
 * by the continuation path. In-flight/indeterminate rows remain hard stops.
 */
export const reconcileAgentToolBatchForRecovery = async (input: {
  runId: string;
  toolCalls: ReadonlyArray<{ id: string }>;
  ledger?: AgentToolInvocationRecoveryLedger;
}) => {
  const ledger = input.ledger || postgresToolRecoveryLedger;
  const ids = new Set<string>();
  for (const call of input.toolCalls) {
    if (!call.id || ids.has(call.id)) {
      throw new Error('Agent recovery tool batch contains a duplicate or empty call id');
    }
    ids.add(call.id);
  }
  return Promise.all(input.toolCalls.map(async (call) => {
    const invocation = await ledger.find({ runId: input.runId, toolCallId: call.id });
    const decision: AgentToolBatchRecoveryDecision = invocation
      ? decideAgentToolInvocationRecovery(invocation)
      : { kind: 'not_started' };
    return Object.freeze({
      toolCallId: call.id,
      toolKey: invocation?.tool_key ?? null,
      decision,
    });
  }));
};

export interface AgentToolExecutionLedger {
  begin: typeof beginAgentToolInvocation;
  finish: typeof finishAgentToolInvocation;
}

const postgresInvocationLedger: AgentToolExecutionLedger = {
  begin: beginAgentToolInvocation,
  finish: finishAgentToolInvocation,
};

const terminalReplayError = () => new AgentToolError(
  'tool_invocation_not_replayable',
  'This tool call is already owned by another runtime or has a terminal outcome',
);

/**
 * Shared invocation state machine for root and delegated Agents.
 *
 * It owns exactly the semantics that must never drift between the two loops:
 * logical identity, durable attempt count, retry contract, cancellation outcome,
 * terminal ledger write and replay fencing. Conversation messages, SSE and child
 * result envelopes remain adapter concerns.
 */
export const executeAgentRuntimeTool = async (
  input: ExecuteAgentToolInput,
): Promise<ExecuteAgentToolResult> => {
  const maximumAttempts = Math.max(1, input.maxAttempts ?? serverEnv.AGENT_TOOL_MAX_ATTEMPTS);
  const ledger = input.ledger ?? postgresInvocationLedger;
  const executionToken = randomUUID();
  const idempotencyKey = buildAgentToolIdempotencyKey({
    runId: input.context.runId,
    toolCallId: input.context.toolCallId,
  });

  const finishOwnedInvocation = async (finish: Parameters<AgentToolExecutionLedger['finish']>[0]) => {
    const settled = await ledger.finish(finish);
    if (!settled) throw terminalReplayError();
    return settled;
  };

  for (;;) {
    const invocation = await ledger.begin({
      runId: input.context.runId,
      toolCallId: input.context.toolCallId,
      toolKey: input.tool.key,
      retryMode: input.tool.retryMode,
      executionToken,
    });
    if (!invocation) throw terminalReplayError();
    const attempt = invocation.attempt_count;

    // Adapter preparation happens before the external call. A failure here has a
    // definite local outcome and must never be mislabeled as a possibly-applied
    // remote write.
    try {
      await input.beforeAttempt?.({ attempt });
    } catch (error) {
      const classified = classifyAgentToolError(error);
      const possiblyAppliedOnEarlierAttempt = attempt > 1 && input.tool.retryMode !== 'safe_read';
      await finishOwnedInvocation({
        runId: input.context.runId,
        toolCallId: input.context.toolCallId,
        executionToken,
        status: possiblyAppliedOnEarlierAttempt ? 'indeterminate' : 'failed',
        errorCode: possiblyAppliedOnEarlierAttempt
          ? 'tool_result_indeterminate'
          : input.classifyRunOutcome?.(error) || classified.code,
      });
      throw error;
    }

    let result: unknown;
    let executionError: unknown;
    try {
      result = await input.tool.execute(input.args, {
        ...input.context,
        idempotencyKey,
        attempt: invocation.attempt_count,
      });
      // A tool that ignores AbortSignal may resolve after cancellation. Never
      // commit that as a normal success.
      input.context.signal.throwIfAborted();
    } catch (error) {
      executionError = error;
    }

    try {
      await input.afterAttempt?.({ attempt, ...(executionError ? { error: executionError } : {}) });
    } catch (settlementError) {
      // A cancellation discovered while restoring adapter state outranks the
      // original tool error. Otherwise retain the original, more specific cause.
      if (!executionError || input.classifyRunOutcome?.(settlementError)) {
        executionError = settlementError;
      }
    }

    if (!executionError) {
      let durableResult: AgentToolInvocationResultPayload;
      try {
        durableResult = input.serializeResult(result);
      } catch (error) {
        const classified = classifyAgentToolError(error);
        const possiblyApplied = input.tool.retryMode !== 'safe_read';
        await finishOwnedInvocation({
          runId: input.context.runId,
          toolCallId: input.context.toolCallId,
          executionToken,
          status: possiblyApplied ? 'indeterminate' : 'failed',
          errorCode: possiblyApplied ? 'tool_result_indeterminate' : classified.code,
        });
        throw new AgentToolError(
          possiblyApplied ? 'tool_result_indeterminate' : classified.code,
          possiblyApplied
            ? 'The tool completed but its durable result could not be recorded safely'
            : classified.message,
          classified.details,
        );
      }
      await finishOwnedInvocation({
        runId: input.context.runId,
        toolCallId: input.context.toolCallId,
        executionToken,
        status: 'succeeded',
        resultPayload: durableResult,
      });
      return { result, durableResult, attempts: attempt, idempotencyKey };
    }

    const runOutcomeCode = input.classifyRunOutcome?.(executionError) || null;
    if (runOutcomeCode) {
      const possiblyApplied = input.tool.retryMode !== 'safe_read';
      await finishOwnedInvocation({
        runId: input.context.runId,
        toolCallId: input.context.toolCallId,
        executionToken,
        status: possiblyApplied ? 'indeterminate' : 'failed',
        errorCode: possiblyApplied ? 'tool_result_indeterminate' : runOutcomeCode,
      });
      throw executionError;
    }

    const decision = decideAgentToolFailure({
      error: executionError,
      retryMode: input.tool.retryMode,
      attempt,
      maxAttempts: maximumAttempts,
    });
    if (decision.action === 'retry') {
      try {
        await input.onRetry?.({
          attempt,
          maxAttempts: maximumAttempts,
          retryMode: input.tool.retryMode,
          error: decision.error,
        });
      } catch (retryHookError) {
        const possiblyApplied = input.tool.retryMode !== 'safe_read';
        const classified = classifyAgentToolError(retryHookError);
        await finishOwnedInvocation({
          runId: input.context.runId,
          toolCallId: input.context.toolCallId,
          executionToken,
          status: possiblyApplied ? 'indeterminate' : 'failed',
          errorCode: possiblyApplied ? 'tool_result_indeterminate' : classified.code,
        });
        throw retryHookError;
      }
      continue;
    }

    await finishOwnedInvocation({
      runId: input.context.runId,
      toolCallId: input.context.toolCallId,
      executionToken,
      status: decision.invocationStatus,
      errorCode: decision.error.code,
    });
    throw new AgentToolError(
      decision.error.code,
      decision.error.message,
      decision.error.details,
    );
  }
};

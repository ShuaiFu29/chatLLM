import { createHash } from 'node:crypto';
import {
  failUnexposedAgentModelInvocation,
  findAgentModelInvocationForRun,
  markAgentModelInvocationExposure,
  restoreAgentModelInvocationResult,
  settleAgentModelInvocation,
  type AgentModelInvocationRow,
  type AgentModelUsageSource,
} from '../../../repositories/agentRunBudgets';
import type {
  ChatMessageParam,
  ChatToolCall,
  ChatToolDefinition,
} from '../../../lib/llmProviders';
import { AgentResourceLimitError, type AgentTokenUsage } from './agent-evidence';

export interface AgentProviderTokenUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

export interface AgentDurableModelResult {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string;
  usage?: AgentTokenUsage;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => [key, sortJsonValue((value as Record<string, unknown>)[key])]));
};

/** Hash every provider-visible request field needed for a safe first invocation. */
export const createAgentModelRequestFingerprint = (input: {
  model: string;
  messages: ChatMessageParam[];
  tools: ChatToolDefinition[];
  maxOutputTokens: number;
  temperature: number;
  responseFormat?: unknown;
}) => createHash('sha256').update(JSON.stringify(sortJsonValue({
  format_version: 1,
  model: input.model,
  messages: input.messages,
  tools: input.tools,
  max_output_tokens: input.maxOutputTokens,
  temperature: input.temperature,
  response_format: input.responseFormat ?? null,
}))).digest('hex');

/**
 * Re-validate the protocol-shaped model snapshot after its hash is checked.
 * The ledger payload is intentionally provider-neutral so root and delegated
 * runtimes can resume from the same assistant/tool-call representation.
 */
export const restoreAgentDurableModelResult = (
  value: Record<string, unknown>,
): Readonly<AgentDurableModelResult> => {
  if (
    typeof value.content !== 'string'
    || typeof value.finish_reason !== 'string'
    || !value.finish_reason
    || !Array.isArray(value.tool_calls)
  ) {
    throw new Error('Agent model result protocol snapshot is invalid');
  }
  const ids = new Set<string>();
  const toolCalls = value.tool_calls.map((rawCall) => {
    if (
      !isRecord(rawCall)
      || typeof rawCall.id !== 'string'
      || !rawCall.id
      || rawCall.type !== 'function'
      || !isRecord(rawCall.function)
      || typeof rawCall.function.name !== 'string'
      || !rawCall.function.name
      || typeof rawCall.function.arguments !== 'string'
      || ids.has(rawCall.id)
    ) {
      throw new Error('Agent model result contains an invalid tool call');
    }
    ids.add(rawCall.id);
    return structuredClone(rawCall) as unknown as ChatToolCall;
  });
  if (!value.content.trim() && toolCalls.length === 0) {
    throw new Error('Agent model result is empty');
  }
  let usage: AgentTokenUsage | undefined;
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) throw new Error('Agent model result usage is invalid');
    const promptTokens = Number(value.usage.prompt_tokens);
    const completionTokens = Number(value.usage.completion_tokens);
    const totalTokens = Number(value.usage.total_tokens);
    if (
      !Number.isSafeInteger(promptTokens) || promptTokens < 0
      || !Number.isSafeInteger(completionTokens) || completionTokens < 0
      || !Number.isSafeInteger(totalTokens) || totalTokens < 0
      || promptTokens + completionTokens !== totalTokens
    ) throw new Error('Agent model result usage is invalid');
    usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };
  }
  return Object.freeze({
    content: value.content,
    toolCalls: Object.freeze(toolCalls) as unknown as ChatToolCall[],
    finishReason: value.finish_reason,
    ...(usage ? { usage: Object.freeze(usage) } : {}),
  });
};

export interface AgentModelInvocationLedger {
  markExposure: typeof markAgentModelInvocationExposure;
  failUnexposed: typeof failUnexposedAgentModelInvocation;
  settle: typeof settleAgentModelInvocation;
}

export interface AgentModelInvocationRecoveryLedger {
  find: typeof findAgentModelInvocationForRun;
  settle: typeof settleAgentModelInvocation;
}

export interface ExecuteReservedAgentModelInvocationInput<T> {
  runId: string;
  workItemId: string;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
  invocation: Pick<AgentModelInvocationRow, 'id' | 'reservation_tokens'>;
  estimatedPromptTokens: number;
  invoke(): Promise<T>;
  /** Protocol checks that must pass before the reservation is committed. */
  validateResult?(value: T): void;
  estimateCompletionTokens(value: T): number;
  readProviderUsage?(value: T): AgentProviderTokenUsage | undefined;
  /** Minimal protocol-validated result needed to resume without provider replay. */
  serializeResult(value: T): Record<string, unknown>;
  recordUsage(usage: AgentTokenUsage): void;
  ledger?: AgentModelInvocationLedger;
}

export interface ExecuteReservedAgentModelInvocationResult<T> {
  value: T;
  usage: AgentTokenUsage;
  usageSource: Extract<AgentModelUsageSource, 'provider_reported' | 'tokenizer_estimated'>;
}

const postgresModelInvocationLedger: AgentModelInvocationLedger = {
  markExposure: markAgentModelInvocationExposure,
  failUnexposed: failUnexposedAgentModelInvocation,
  settle: settleAgentModelInvocation,
};

const postgresModelInvocationRecoveryLedger: AgentModelInvocationRecoveryLedger = {
  find: findAgentModelInvocationForRun,
  settle: settleAgentModelInvocation,
};

/**
 * Persist the exact reservation before the first byte can reach the provider.
 * If checkpoint fencing rejects the owner, the untouched reservation is
 * released as a zero-usage failed attempt instead of being charged as unknown.
 */
export const checkpointReservedAgentModelInvocation = async <T>(input: {
  runId: string;
  invocation: Pick<AgentModelInvocationRow, 'id' | 'reservation_tokens'>;
  estimatedPromptTokens: number;
  requestHash: string;
  saveCheckpoint(modelInvocation: {
    invocationId: string;
    reservationTokens: number;
    estimatedPromptTokens: number;
    requestHash: string;
  }): Promise<T>;
  ledger?: AgentModelInvocationLedger;
}) => {
  const ledger = input.ledger || postgresModelInvocationLedger;
  try {
    if (!/^[0-9a-f]{64}$/.test(input.requestHash)) {
      throw new Error('Agent model request fingerprint is invalid');
    }
    return await input.saveCheckpoint({
      invocationId: input.invocation.id,
      reservationTokens: input.invocation.reservation_tokens,
      estimatedPromptTokens: input.estimatedPromptTokens,
      requestHash: input.requestHash,
    });
  } catch (error) {
    await ledger.settle({
      invocationId: input.invocation.id,
      runId: input.runId,
      status: 'failed',
      actualTokens: 0,
      usageSource: 'not_invoked',
    }).catch(() => null);
    throw error;
  }
};

export type AgentModelInvocationRecoveryDecision =
  | {
    kind: 'not_started';
    invocation: Pick<AgentModelInvocationRow, 'id' | 'reservation_tokens'>;
  }
  | {
    kind: 'reuse';
    result: Record<string, unknown>;
    actualTokens: number;
    usageSource: AgentModelUsageSource;
  }
  | {
    kind: 'stop';
    reason: 'invocation_missing'
      | 'provider_outcome_unknown'
      | 'invocation_failed'
      | 'invocation_indeterminate'
      | 'legacy_result_missing';
    chargedUsage?: AgentTokenUsage;
  };

/**
 * Reconcile the invocation named by model_ready without replaying a provider
 * request. An unexposed reservation is safe to execute under the new Work Item
 * claim. An exposed reservation still has an unknown provider outcome, so
 * recovery charges the full exposure and stops.
 */
export const recoverAgentModelInvocation = async (input: {
  runId: string;
  invocationId: string;
  ledger?: AgentModelInvocationRecoveryLedger;
}): Promise<AgentModelInvocationRecoveryDecision> => {
  const ledger = input.ledger || postgresModelInvocationRecoveryLedger;
  let invocation = await ledger.find({
    invocationId: input.invocationId,
    runId: input.runId,
  });
  if (!invocation) return { kind: 'stop', reason: 'invocation_missing' };
  if (invocation.status === 'reserved' && invocation.exposure_started_at === null) {
    return {
      kind: 'not_started',
      invocation: {
        id: invocation.id,
        reservation_tokens: invocation.reservation_tokens,
      },
    };
  }
  const providerOutcomeWasUnknown = invocation.status === 'reserved';
  if (invocation.status === 'reserved') {
    const settled = await ledger.settle({
      invocationId: invocation.id,
      runId: input.runId,
      status: 'indeterminate',
      actualTokens: invocation.reservation_tokens,
      usageSource: 'reservation_conservative',
    });
    if (!settled) return { kind: 'stop', reason: 'invocation_missing' };
    invocation = settled;
  }
  if (invocation.status === 'succeeded') {
    const result = restoreAgentModelInvocationResult(invocation);
    if (!result) return { kind: 'stop', reason: 'legacy_result_missing' };
    return {
      kind: 'reuse',
      result,
      actualTokens: invocation.actual_tokens || 0,
      usageSource: invocation.usage_source || 'tokenizer_estimated',
    };
  }
  if (invocation.status === 'failed') {
    return { kind: 'stop', reason: 'invocation_failed' };
  }
  return {
    kind: 'stop',
    reason: providerOutcomeWasUnknown
      ? 'provider_outcome_unknown'
      : invocation.status === 'indeterminate'
      ? 'invocation_indeterminate'
      : 'provider_outcome_unknown',
    ...(invocation.status === 'indeterminate' ? {
      chargedUsage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: invocation.actual_tokens || invocation.reservation_tokens,
      },
    } : {}),
  };
};

const safeTokenCount = (value: unknown) => (
  Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0
);

const normalizeMeasuredUsage = (input: {
  providerUsage?: AgentProviderTokenUsage;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
}) => {
  const providerTotal = input.providerUsage?.total_tokens;
  if (Number.isInteger(providerTotal) && Number(providerTotal) >= 0) {
    return {
      usage: {
        prompt_tokens: safeTokenCount(input.providerUsage?.prompt_tokens),
        completion_tokens: safeTokenCount(input.providerUsage?.completion_tokens),
        total_tokens: Number(providerTotal),
      },
      usageSource: 'provider_reported' as const,
    };
  }
  return {
    usage: {
      prompt_tokens: input.estimatedPromptTokens,
      completion_tokens: input.estimatedCompletionTokens,
      total_tokens: input.estimatedPromptTokens + input.estimatedCompletionTokens,
    },
    usageSource: 'tokenizer_estimated' as const,
  };
};

/**
 * Shared post-reservation state machine for root and delegated model calls.
 *
 * The provider request, streaming adapter and response shape remain caller
 * concerns. This kernel owns the invariant that every reserved exposure reaches
 * exactly one durable terminal state and exactly one Run usage update. Unknown
 * provider outcomes consume the full reservation rather than silently returning
 * it to the tree budget.
 */
export const executeReservedAgentModelInvocation = async <T>(
  input: ExecuteReservedAgentModelInvocationInput<T>,
): Promise<ExecuteReservedAgentModelInvocationResult<T>> => {
  const ledger = input.ledger || postgresModelInvocationLedger;
  let invocationSettled = false;
  let providerExposureStarted = false;
  let exposureFenceLost = false;
  let usageRecorded = false;

  const recordUsageOnce = (usage: AgentTokenUsage) => {
    if (usageRecorded) return;
    usageRecorded = true;
    input.recordUsage(usage);
  };

  try {
    let exposed: AgentModelInvocationRow | null = null;
    try {
      exposed = await ledger.markExposure({
        invocationId: input.invocation.id,
        runId: input.runId,
        workItemId: input.workItemId,
        workItemLeaseToken: input.workItemLeaseToken,
        workItemFencingGeneration: input.workItemFencingGeneration,
      });
    } catch {
      // The marker may have failed before commit, or its response may have been
      // lost after commit. The fenced release below is allowed only in the first
      // case, while this Worker still owns an unexposed reservation.
    }
    if (!exposed) {
      const released = await ledger.failUnexposed({
        invocationId: input.invocation.id,
        runId: input.runId,
        workItemId: input.workItemId,
        workItemLeaseToken: input.workItemLeaseToken,
        workItemFencingGeneration: input.workItemFencingGeneration,
      }).catch(() => null);
      if (released?.status === 'failed') {
        invocationSettled = true;
        recordUsageOnce({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
      } else {
        exposureFenceLost = true;
      }
      throw new Error('Agent model exposure fence was lost before provider invocation');
    }
    providerExposureStarted = true;
    const value = await input.invoke();
    input.validateResult?.(value);
    const estimatedCompletionTokens = safeTokenCount(input.estimateCompletionTokens(value));
    const measured = normalizeMeasuredUsage({
      providerUsage: input.readProviderUsage?.(value),
      estimatedPromptTokens: safeTokenCount(input.estimatedPromptTokens),
      estimatedCompletionTokens,
    });
    const actualTokens = safeTokenCount(measured.usage.total_tokens);
    const durableResult = {
      ...input.serializeResult(value),
      // Recovery must update the Run's usage projection exactly as the original
      // loop would have. The budget ledger stores total exposure; keep the split
      // beside the protocol result so it survives the settlement/checkpoint gap.
      usage: measured.usage,
    };
    if (actualTokens > input.invocation.reservation_tokens) {
      await ledger.settle({
        invocationId: input.invocation.id,
        runId: input.runId,
        status: 'indeterminate',
        actualTokens: input.invocation.reservation_tokens,
        usageSource: 'reservation_conservative',
      });
      invocationSettled = true;
      recordUsageOnce({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: input.invocation.reservation_tokens,
      });
      throw new AgentResourceLimitError('Agent model usage exceeded its reservation');
    }
    const settled = await ledger.settle({
      invocationId: input.invocation.id,
      runId: input.runId,
      status: 'succeeded',
      actualTokens,
      usageSource: measured.usageSource,
      resultPayload: durableResult,
    });
    if (settled?.status !== 'succeeded') {
      throw new Error('Agent model reservation lost before settlement');
    }
    invocationSettled = true;
    recordUsageOnce(measured.usage);
    return { value, ...measured };
  } catch (error) {
    if (!invocationSettled && !exposureFenceLost) {
      await ledger.settle({
        invocationId: input.invocation.id,
        runId: input.runId,
        status: 'indeterminate',
        actualTokens: input.invocation.reservation_tokens,
        usageSource: 'reservation_conservative',
      }).catch(() => null);
    }
    if (!exposureFenceLost) {
      recordUsageOnce(providerExposureStarted ? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: input.invocation.reservation_tokens,
      } : {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      });
    }
    throw error;
  }
};

import type { ChatMessageParam } from '../../../lib/llmProviders';
import { AgentResourceLimitError } from './agent-evidence';
import {
  estimateAgentModelRequestTokens,
  type AgentModelResponseFormat,
} from './agent-output-contract';

export interface AgentModelRequestPlan {
  estimatedPromptTokens: number;
  maxOutputTokens: number;
  reservationTokens: number;
  contextWindowTokens: number;
  fitsContext: boolean;
}

export const planAgentModelRequest = (input: {
  messages: ChatMessageParam[];
  tools: Array<{ definition: unknown }>;
  responseFormat?: AgentModelResponseFormat;
  maxOutputTokens: number;
  contextWindowTokens: number;
}): AgentModelRequestPlan => {
  if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
    throw new AgentResourceLimitError('Agent maximum output tokens must be a positive integer');
  }
  if (!Number.isInteger(input.contextWindowTokens) || input.contextWindowTokens <= 0) {
    throw new AgentResourceLimitError('Agent model context window must be a positive integer');
  }
  const estimatedPromptTokens = estimateAgentModelRequestTokens(
    input.messages,
    input.tools,
    input.responseFormat,
  );
  const reservationTokens = estimatedPromptTokens + input.maxOutputTokens;
  return Object.freeze({
    estimatedPromptTokens,
    maxOutputTokens: input.maxOutputTokens,
    reservationTokens,
    contextWindowTokens: input.contextWindowTokens,
    fitsContext: reservationTokens <= input.contextWindowTokens,
  });
};

export type AgentToolBatchDecision =
  | {
    granted: true;
    usedCalls: number;
    requestedCalls: number;
    resultingCalls: number;
  }
  | {
    granted: false;
    reason: 'per_iteration' | 'run_total';
    usedCalls: number;
    requestedCalls: number;
    resultingCalls: number;
    limit: number;
  };

const nonNegativeInteger = (value: number, field: string) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new AgentResourceLimitError(`${field} must be a non-negative integer`);
  }
  return value;
};

/** Decide the fate of a complete provider tool batch before its first call. */
export const decideAgentToolBatch = (input: {
  usedCalls: number;
  requestedCalls: number;
  perIterationLimit: number;
  runTotalLimit: number;
}): AgentToolBatchDecision => {
  const usedCalls = nonNegativeInteger(input.usedCalls, 'Agent used tool calls');
  const requestedCalls = nonNegativeInteger(input.requestedCalls, 'Agent requested tool calls');
  const perIterationLimit = nonNegativeInteger(
    input.perIterationLimit,
    'Agent per-iteration tool limit',
  );
  const runTotalLimit = nonNegativeInteger(input.runTotalLimit, 'Agent total tool limit');
  const resultingCalls = usedCalls + requestedCalls;
  if (requestedCalls > perIterationLimit) {
    return {
      granted: false,
      reason: 'per_iteration',
      usedCalls,
      requestedCalls,
      resultingCalls,
      limit: perIterationLimit,
    };
  }
  if (resultingCalls > runTotalLimit) {
    return {
      granted: false,
      reason: 'run_total',
      usedCalls,
      requestedCalls,
      resultingCalls,
      limit: runTotalLimit,
    };
  }
  return { granted: true, usedCalls, requestedCalls, resultingCalls };
};

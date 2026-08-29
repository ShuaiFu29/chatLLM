import type { AgentToolRetryMode } from './agent-tool';
import {
  classifyAgentToolError,
  isRetryableAgentToolErrorCode,
  type ClassifiedAgentToolError,
} from './agent-tool-error';

export type AgentToolInvocationTerminalStatus = 'failed' | 'indeterminate';

export type AgentToolFailureDecision = {
  action: 'retry';
  error: ClassifiedAgentToolError;
} | {
  action: 'stop';
  error: ClassifiedAgentToolError;
  invocationStatus: AgentToolInvocationTerminalStatus;
};

/**
 * Decide whether one failed attempt may be repeated.
 *
 * A timeout or broken connection says nothing about whether a request reached a
 * remote service. Reads are safe to repeat. Writes are safe only when the tool
 * definition explicitly records a de-duplication contract. Every other unknown
 * write outcome is surfaced as `tool_result_indeterminate` instead of being
 * silently repeated or mislabeled as a definite failure.
 */
export const decideAgentToolFailure = (input: {
  error: unknown;
  retryMode: AgentToolRetryMode;
  attempt: number;
  maxAttempts: number;
}): AgentToolFailureDecision => {
  const classified = classifyAgentToolError(input.error);
  const transportFailure = isRetryableAgentToolErrorCode(classified.code);
  const hasRetryContract = input.retryMode === 'safe_read'
    || input.retryMode === 'idempotent_write';

  if (transportFailure && hasRetryContract && input.attempt < input.maxAttempts) {
    return { action: 'retry', error: classified };
  }

  if (transportFailure && input.retryMode !== 'safe_read') {
    return {
      action: 'stop',
      invocationStatus: 'indeterminate',
      error: {
        code: 'tool_result_indeterminate',
        message: 'The tool may have completed, but no authoritative result was received',
        details: {
          cause: classified.code,
          retry_mode: input.retryMode,
          attempts: input.attempt,
        },
      },
    };
  }

  return { action: 'stop', invocationStatus: 'failed', error: classified };
};

import { AgentResourceLimitError } from './agent-evidence';

export class AgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProtocolError';
  }
}

/** A completed OpenAI-compatible turn must carry an explicit finish reason. */
export const assertModelResponseComplete = (finishReason: unknown) => {
  if (typeof finishReason !== 'string' || finishReason.trim() === '') {
    throw new AgentProtocolError('Agent model response ended without a finish reason');
  }
  return finishReason;
};

/**
 * Tool calls are executable only when the provider completed their serialized
 * arguments and tools were actually advertised on this turn.
 */
export const assertModelToolCallsExecutable = (input: {
  finishReason: unknown;
  toolCallCount: number;
  toolsAdvertised: boolean;
}) => {
  if (input.toolCallCount <= 0) return;
  const finishReason = assertModelResponseComplete(input.finishReason);
  if (finishReason === 'length') {
    throw new AgentResourceLimitError(
      'Agent tool call was truncated by the output size limit',
    );
  }
  if (!input.toolsAdvertised) {
    throw new AgentProtocolError(
      'Agent model requested a tool that was not available on this turn',
    );
  }
};

export const assertModelFinalAnswerNotTruncated = (finishReason: unknown) => {
  if (assertModelResponseComplete(finishReason) === 'length') {
    throw new AgentResourceLimitError('Agent final response reached the output size limit');
  }
};

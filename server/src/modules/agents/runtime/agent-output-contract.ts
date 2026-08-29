import type { ChatMessageParam } from '../../../lib/llmProviders';
import { parseAndValidateAgentJsonOutput } from './json-schema-input';

export type AgentOutputFormat = 'markdown' | 'json';
export type AgentModelResponseFormat = { type: 'json_object' };

export interface AgentOutputContract {
  responseFormat: AgentOutputFormat;
  outputSchema: Record<string, unknown>;
  promptInstruction: string;
  modelResponseFormat?: AgentModelResponseFormat;
  validate(content: string): string;
  correctionMessage(error: unknown): string;
}

const freezeJsonValue = <T>(value: T): T => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeJsonValue(nested);
  }
  return Object.freeze(value);
};

export const buildAgentOutputInstruction = (
  responseFormat: AgentOutputFormat,
  outputSchema?: Record<string, unknown> | null,
) => responseFormat === 'json'
  ? `Return one valid JSON object. Required output schema: ${JSON.stringify(outputSchema || {})}`
  : '';

export const resolveAgentModelResponseFormat = (
  responseFormat: AgentOutputFormat,
  supportsStructuredOutput: boolean,
) => responseFormat === 'json' && supportsStructuredOutput
  ? { type: 'json_object' as const }
  : undefined;

export const validateAgentOutputContent = (input: {
  content: string;
  responseFormat: AgentOutputFormat;
  outputSchema?: Record<string, unknown> | null;
}) => input.responseFormat === 'json'
  ? JSON.stringify(parseAndValidateAgentJsonOutput(
      input.content,
      input.outputSchema || {},
    ))
  : input.content;

export const buildAgentOutputCorrectionMessage = (error: unknown) => (
  'Your previous response was invalid JSON or did not match the required schema. '
  + 'Return only one corrected JSON object. Validation error: '
  + `${error instanceof Error ? error.message : 'invalid output'}`
);

export const createAgentOutputContract = (input: {
  responseFormat: AgentOutputFormat;
  outputSchema?: Record<string, unknown> | null;
  supportsStructuredOutput: boolean;
}): AgentOutputContract => {
  const outputSchema = freezeJsonValue(structuredClone(input.outputSchema || {}));
  return Object.freeze({
    responseFormat: input.responseFormat,
    outputSchema,
    promptInstruction: buildAgentOutputInstruction(input.responseFormat, outputSchema),
    modelResponseFormat: resolveAgentModelResponseFormat(
      input.responseFormat,
      input.supportsStructuredOutput,
    ),
    validate: (content: string) => validateAgentOutputContent({
      content,
      responseFormat: input.responseFormat,
      outputSchema,
    }),
    correctionMessage: buildAgentOutputCorrectionMessage,
  });
};

/**
 * One conservative request estimate for both the streaming root runtime and
 * non-streaming delegated runtime. Tool definitions and structured-output
 * metadata are part of the provider payload and therefore part of the budget.
 */
export const estimateAgentModelRequestTokens = (
  messages: ChatMessageParam[],
  tools: Array<{ definition: unknown }>,
  responseFormat?: AgentModelResponseFormat,
) => Math.ceil(Buffer.byteLength(JSON.stringify({
  messages,
  tools: tools.map((tool) => tool.definition),
  response_format: responseFormat,
}), 'utf8') / 3);

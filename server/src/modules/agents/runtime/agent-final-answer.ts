import type { ChatSource } from '../../../lib/chatSources';
import { buildInsufficientEvidenceAnswer } from '../../../services/answerGeneration';
import {
  AgentEvidenceCollector,
  extractJsonGroundingText,
  summarizeAgentGrounding,
  type AgentEvidenceSnapshot,
} from './agent-evidence';
import { validateAgentOutputContent, type AgentOutputFormat } from './agent-output-contract';
import { buildAgentJsonInsufficientEvidenceOutput } from './json-schema-input';

export interface PreparedAgentFinalAnswer {
  content: string;
  sources: ChatSource[];
  grounding?: Record<string, unknown>;
  evidence: AgentEvidenceCollector;
}

/**
 * Deterministic final validation shared by the live root loop and recovery.
 * It performs no model/tool call, so a durable provider result can safely pass
 * through it after a worker crash without changing the answer contract.
 */
export const prepareAgentFinalAnswer = (input: {
  rawContent: string;
  question: string;
  responseFormat: AgentOutputFormat;
  outputSchema?: Record<string, unknown> | null;
  evidenceSnapshot: AgentEvidenceSnapshot;
}): PreparedAgentFinalAnswer => {
  let content = validateAgentOutputContent({
    content: input.rawContent,
    responseFormat: input.responseFormat,
    outputSchema: input.outputSchema,
  });
  const evidence = new AgentEvidenceCollector().restore(input.evidenceSnapshot);
  let sources = evidence.sources;
  let grounding: Record<string, unknown> | undefined;
  if (evidence.evidenceUsed) {
    const verification = evidence.verify(input.responseFormat === 'json'
      ? extractJsonGroundingText(content)
      : content);
    sources = verification.verified_sources;
    grounding = {
      ...summarizeAgentGrounding(verification),
      ...(evidence.warnings.length > 0 ? { warnings: evidence.warnings } : {}),
    };
    if (verification.status === 'unsupported') {
      const refusal = buildInsufficientEvidenceAnswer(input.question);
      content = input.responseFormat === 'json'
        ? JSON.stringify(buildAgentJsonInsufficientEvidenceOutput(
            input.outputSchema || {},
            refusal,
          ))
        : refusal;
    }
  }
  return { content, sources, ...(grounding ? { grounding } : {}), evidence };
};

import {
  AnswerClaimEvaluation,
  buildAnswerTaskGuidance,
  buildChatSources,
  buildVerificationSources,
  ChatSource,
  evaluateAnswerClaims,
  packRagAnswerContext,
  RAG_ANSWER_CONTEXT_BUDGET_TOKENS,
  RagTraceStep,
  RagTraceSummary,
} from '../lib/chatSources';
import { createChatClientForModel, getDefaultChatModel } from '../lib/llmProviders';
import {
  AgenticRagResponse,
  RagConversationContextItem,
  retrieveAgenticRagDocuments,
} from '../lib/ragClient';

export const GROUNDED_ANSWER_PROMPT_VERSION = 'grounded-answer-v1';
export const DETERMINISTIC_ABSTENTION_VERSION = 'deterministic-abstention-v1';
export const DEFAULT_ANSWER_SYSTEM_PROMPT = 'You are a helpful AI assistant.';
export const MAX_RETRIEVAL_CONVERSATION_CONTEXT = 6;

const DEFAULT_INSUFFICIENT_EVIDENCE_GUIDANCE =
  'No usable workspace evidence was retrieved. Do not answer from general knowledge or invent citations; state that the workspace source material is insufficient.';

export interface AnswerMessage extends RagConversationContextItem {}

type ChatClient = ReturnType<typeof createChatClientForModel>['client'];

const withoutTrailingCurrentQuestion = (messages: AnswerMessage[], question: string) => {
  const normalized = messages.map((message) => ({
    role: message.role,
    content: String(message.content || '').trim(),
  })).filter((message) => message.content);
  const last = normalized[normalized.length - 1];
  if (last?.role === 'user' && last.content === question.trim()) normalized.pop();
  return normalized;
};

export const buildRetrievalConversationContext = (
  historyNewestFirst: AnswerMessage[],
  currentQuestion: string,
  limit = MAX_RETRIEVAL_CONVERSATION_CONTEXT,
) => {
  const chronological = [...historyNewestFirst].reverse();
  return withoutTrailingCurrentQuestion(chronological, currentQuestion)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-Math.max(0, limit));
};

const groundedQuestion = (
  question: string,
  contextText: string,
  answerGuidance = '',
) => {
  const evidenceGuidance = answerGuidance ? `${answerGuidance}\n\n` : '';
  const taskGuidance = buildAnswerTaskGuidance(question);
  if (!contextText) {
    return `${evidenceGuidance || `${DEFAULT_INSUFFICIENT_EVIDENCE_GUIDANCE}\n\n`}${taskGuidance}\n\nNo workspace evidence is available for this request.
Do not answer the question from general knowledge.
State only that the retrieved workspace source material is insufficient and suggest adding or selecting relevant documents.
Do not include source labels or unsupported factual claims.

Question:
${question}`;
  }
  return `${evidenceGuidance}${taskGuidance}\n\nBased on the following context, please answer the user's question.
If the answer is not in the context, say that the retrieved source material is insufficient.
Do not use general knowledge as document evidence, and do not attach citations to claims that are not supported by the context.
Use source labels such as [Source 1] only when the claim is directly supported by that source.
Answer every explicit part of the question instead of stopping after the first relevant fact.
Answer in the same language as the user's question unless the user explicitly requests another language.
Preserve material numbers, units, versions, dates, conditions, exceptions, and negation exactly as supported by the sources.
Place a source label immediately after each substantive document-backed claim; do not use one citation group to cover unrelated claims.
Distinguish current rules from deprecated or historical material when the sources state that distinction.
Inventory rows are context for document-list questions; do not treat them as document evidence citations.
Do not mention "Based on the provided context" or similar phrases in your answer unless necessary to clarify source limits.

Context:
${contextText}

Question:
${question}`;
};

export const buildInsufficientEvidenceAnswer = (question: string) => (
  /[\u3400-\u9fff]/u.test(question)
    ? '当前检索到的工作区资料不足以回答这个问题。请补充或选择相关文档后重试。'
    : 'The retrieved workspace source material is insufficient to answer this question. Add or select relevant documents and try again.'
);

export const buildGroundedAnswerMessages = (input: {
  systemPrompt: string;
  historyNewestFirst: AnswerMessage[];
  question: string;
  contextText?: string;
  answerGuidance?: string;
}) => {
  const chronological = withoutTrailingCurrentQuestion(
    [...input.historyNewestFirst].reverse(),
    input.question,
  );
  return [
    { role: 'system' as const, content: input.systemPrompt },
    ...chronological,
    {
      role: 'user' as const,
      content: groundedQuestion(input.question, input.contextText || '', input.answerGuidance),
    },
  ];
};

export interface PreparedGroundedAnswer {
  ragRun: AgenticRagResponse;
  contextText: string;
  assistantSources: ChatSource[];
  verificationSources: ChatSource[];
  traceSummary: RagTraceSummary;
  insufficientEvidence: boolean;
  answerGuidance: string;
  answerContextDocuments: AgenticRagResponse['results'];
}

export const prepareGroundedAnswer = async (input: {
  question: string;
  userId: string;
  projectSpaceId?: string;
  conversationId?: string;
  historyNewestFirst?: AnswerMessage[];
  limit?: number;
  threshold?: number;
  contextBudgetTokens?: number;
  signal?: AbortSignal;
  retrieve?: typeof retrieveAgenticRagDocuments;
}): Promise<PreparedGroundedAnswer> => {
  const retrieve = input.retrieve || retrieveAgenticRagDocuments;
  const ragRun = await retrieve({
    query: input.question,
    user_id: input.userId,
    project_space_id: input.projectSpaceId,
    conversation_id: input.conversationId,
    conversation_context: buildRetrievalConversationContext(
      input.historyNewestFirst || [],
      input.question,
    ),
    limit: input.limit ?? 10,
    threshold: input.threshold ?? 0.1,
  }, input.signal);
  const documents = ragRun.results || [];
  const contextBuild = packRagAnswerContext(
    documents,
    input.contextBudgetTokens ?? RAG_ANSWER_CONTEXT_BUDGET_TOKENS,
  );
  const assistantSources = buildChatSources(contextBuild.documents);
  const verificationSources = buildVerificationSources(contextBuild.documents);
  const insufficientEvidence = Boolean(
    ragRun.insufficient_evidence
    || !contextBuild.text.trim()
    || assistantSources.length === 0
  );
  const answerGuidance = ragRun.answer_guidance
    || (insufficientEvidence ? DEFAULT_INSUFFICIENT_EVIDENCE_GUIDANCE : '');
  const contextStep: RagTraceStep = {
    step_type: 'answer_context_pack',
    status: contextBuild.truncated ? 'partial' : 'success',
    duration_ms: 0,
    input: {
      document_count: documents.length,
      deduplicated_document_count: contextBuild.documents.length,
      budget_tokens: contextBuild.budget_tokens,
    },
    output: {
      estimated_tokens: contextBuild.estimated_tokens,
      truncated: contextBuild.truncated,
      source_map: contextBuild.source_map,
      allocations: contextBuild.allocations,
    },
  };
  return {
    ragRun,
    contextText: contextBuild.text,
    assistantSources,
    verificationSources,
    traceSummary: {
      mode: ragRun.mode,
      intent: ragRun.intent,
      planned_queries: ragRun.planned_queries || [],
      trace_steps: [...(ragRun.trace_steps || []), contextStep],
      quality: ragRun.quality,
      insufficient_evidence: insufficientEvidence,
      answer_guidance: answerGuidance,
      cache: ragRun.cache,
    },
    insufficientEvidence,
    answerGuidance,
    answerContextDocuments: contextBuild.documents,
  };
};

interface AnswerCompletionInput {
  client: ChatClient;
  resolvedModel: string;
  messages: ReturnType<typeof buildGroundedAnswerMessages>;
  temperature: number;
  signal?: AbortSignal;
}

export interface AnswerTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

const normalizeTokenUsage = (usage: unknown): AnswerTokenUsage | undefined => {
  if (!usage || typeof usage !== 'object') return undefined;
  const value = usage as Record<string, unknown>;
  const promptTokens = Number(value.prompt_tokens ?? 0);
  const completionTokens = Number(value.completion_tokens ?? 0);
  const totalTokens = Number(value.total_tokens ?? promptTokens + completionTokens);
  if (![promptTokens, completionTokens, totalTokens].every(Number.isFinite)) return undefined;
  return {
    prompt_tokens: Math.max(0, promptTokens),
    completion_tokens: Math.max(0, completionTokens),
    total_tokens: Math.max(0, totalTokens),
  };
};

export const streamGroundedAnswer = (input: AnswerCompletionInput) => (
  input.client.chat.completions.create({
    model: input.resolvedModel,
    messages: input.messages,
    stream: true,
    temperature: input.temperature,
    signal: input.signal,
  })
);

const generateGroundedAnswerCompletion = async (input: AnswerCompletionInput) => {
  const response = await input.client.chat.completions.create({
    model: input.resolvedModel,
    messages: input.messages,
    stream: false,
    temperature: input.temperature,
    signal: input.signal,
  });
  const actualAnswer = String(response.choices[0]?.message?.content || '').trim();
  if (!actualAnswer) throw new Error('Answer model returned an empty response');
  return { actualAnswer, tokenUsage: normalizeTokenUsage(response.usage) };
};

export const generateGroundedAnswer = async (input: AnswerCompletionInput) => (
  (await generateGroundedAnswerCompletion(input)).actualAnswer
);

export interface GeneratedEvaluatedAnswer {
  actualAnswer: string;
  modelVersion: string;
  provider: string;
  promptVersion: string;
  prepared: PreparedGroundedAnswer;
  claimEvaluation: AnswerClaimEvaluation;
  tokenUsage?: AnswerTokenUsage;
}

export const generateEvaluatedRagAnswer = async (input: {
  question: string;
  userId: string;
  projectSpaceId?: string;
  conversationId?: string;
  historyNewestFirst?: AnswerMessage[];
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<GeneratedEvaluatedAnswer> => {
  const prepared = await prepareGroundedAnswer({
    question: input.question,
    userId: input.userId,
    projectSpaceId: input.projectSpaceId,
    conversationId: input.conversationId,
    historyNewestFirst: input.historyNewestFirst,
    signal: input.signal,
  });
  if (prepared.insufficientEvidence && !prepared.contextText.trim()) {
    const actualAnswer = buildInsufficientEvidenceAnswer(input.question);
    return {
      actualAnswer,
      modelVersion: DETERMINISTIC_ABSTENTION_VERSION,
      provider: 'local-policy',
      promptVersion: GROUNDED_ANSWER_PROMPT_VERSION,
      tokenUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      prepared,
      claimEvaluation: evaluateAnswerClaims(actualAnswer, [], true),
    };
  }
  const model = input.model || getDefaultChatModel();
  const { client, provider, resolvedModel } = createChatClientForModel(model);
  const messages = buildGroundedAnswerMessages({
    systemPrompt: input.systemPrompt || DEFAULT_ANSWER_SYSTEM_PROMPT,
    historyNewestFirst: input.historyNewestFirst || [],
    question: input.question,
    contextText: prepared.contextText,
    answerGuidance: prepared.answerGuidance,
  });
  const completion = await generateGroundedAnswerCompletion({
    client,
    resolvedModel,
    messages,
    temperature: input.temperature ?? 0,
    signal: input.signal,
  });
  return {
    actualAnswer: completion.actualAnswer,
    modelVersion: resolvedModel,
    provider,
    promptVersion: GROUNDED_ANSWER_PROMPT_VERSION,
    tokenUsage: completion.tokenUsage,
    prepared,
    claimEvaluation: evaluateAnswerClaims(
      completion.actualAnswer,
      prepared.verificationSources,
      prepared.insufficientEvidence,
    ),
  };
};

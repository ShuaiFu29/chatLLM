import { createHash } from 'node:crypto';

export interface AgentMemoryQueryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type AgentMemoryQueryResolutionMethod =
  | 'not_required'
  | 'context_unavailable'
  | 'previous_user_turn_context';

export interface AgentMemoryQueryResolution {
  originalQuery: string;
  resolvedQuery: string;
  contextDependent: boolean;
  method: AgentMemoryQueryResolutionMethod;
  historyTurnsUsed: number;
  rewritten: boolean;
  originalQueryHash: string;
  resolvedQueryHash: string;
}

const MAX_MEMORY_RETRIEVAL_QUERY_CHARS = 2_000;
const REFERENCE_PATTERN = /(?:那么|其中|前者|后者|上述|这个|那个|这些|它|其|该(?:服务|系统|组件|机制|策略|规则|流程|方案)?)|\b(?:it|its|this|that|these|those|former|latter)\b/iu;
const FOLLOW_UP_PREFIX_PATTERN = /^(?:那|and\s+what\b|what\s+about\b|how\s+about\b|then(?:\s+what)?\b|what\s+else\b)/iu;
const FOLLOW_UP_PATTERN = /^(?:(?:还|再)(?:有)?(?:哪些|什么)?(?:限制|条件|区别|影响|风险|步骤)(?:呢|吗)?|(?:失败|成功|完成|超时|重试|取消)(?:后|以后|时|了)?(?:会)?(?:怎样|如何|怎么办|呢|吗)?|(?:然后|接着|另外)(?:呢|怎么办)?|(?:为什么|怎么|如何)(?:呢)?|(?:和|与).{1,80}(?:相比|比较)|第(?:[一二三四五六七八九十]|\d+)(?:个|种|条|点|项|步|阶段|方案|方法).{0,50})\s*[？?]?$/iu;

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export const isAgentMemoryQueryContextDependent = (query: string) => {
  const normalized = normalize(query);
  return Boolean(normalized && (
    REFERENCE_PATTERN.test(normalized)
    || FOLLOW_UP_PREFIX_PATTERN.test(normalized)
    || FOLLOW_UP_PATTERN.test(normalized)
  ));
};

/**
 * Resolve an elliptical Memory query without an additional model call.
 *
 * Only user turns are carried forward. Assistant output is untrusted generated
 * text and must never invent a durable-retrieval subject. The final string is
 * bounded before it reaches the embedding provider.
 */
export const resolveAgentMemoryRetrievalQuery = (
  question: string,
  recentNewestFirst: readonly AgentMemoryQueryMessage[],
): AgentMemoryQueryResolution => {
  const originalQuery = normalize(question).slice(0, MAX_MEMORY_RETRIEVAL_QUERY_CHARS);
  const contextDependent = isAgentMemoryQueryContextDependent(originalQuery);
  const previousUserQueries = recentNewestFirst
    .filter((message) => message.role === 'user')
    .map((message) => normalize(message.content).slice(0, 1_000))
    .filter((content) => content && content !== originalQuery);

  if (!contextDependent || previousUserQueries.length === 0) {
    const method = contextDependent ? 'context_unavailable' : 'not_required';
    return Object.freeze({
      originalQuery,
      resolvedQuery: originalQuery,
      contextDependent,
      method,
      historyTurnsUsed: 0,
      rewritten: false,
      originalQueryHash: digest(originalQuery),
      resolvedQueryHash: digest(originalQuery),
    });
  }

  const selectedNewestFirst = [previousUserQueries[0]];
  for (const earlier of previousUserQueries.slice(1)) {
    if (selectedNewestFirst.length >= 3) break;
    if (!isAgentMemoryQueryContextDependent(selectedNewestFirst.at(-1) || '')) break;
    selectedNewestFirst.push(earlier);
  }
  const context = [...selectedNewestFirst]
    .reverse()
    .map((item) => item.replace(/[。！？!?；;\s]+$/u, ''))
    .join('；上下文追问：');
  const currentQuestionSuffix = `；当前追问：${originalQuery}`;
  const contextBudget = Math.max(
    0,
    MAX_MEMORY_RETRIEVAL_QUERY_CHARS - currentQuestionSuffix.length,
  );
  // Preserve the complete current question. When history is unusually long,
  // trim its oldest prefix instead of truncating exact markers in the current
  // turn that the user just supplied.
  const resolvedQuery = `${context.slice(-contextBudget)}${currentQuestionSuffix}`;
  return Object.freeze({
    originalQuery,
    resolvedQuery,
    contextDependent: true,
    method: 'previous_user_turn_context',
    historyTurnsUsed: selectedNewestFirst.length,
    rewritten: resolvedQuery !== originalQuery,
    originalQueryHash: digest(originalQuery),
    resolvedQueryHash: digest(resolvedQuery),
  });
};

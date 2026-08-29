import {
  cosineSimilarity,
  type AgentMemoryRow,
  type AgentMemorySourceTrust,
} from '../../../repositories/agentMemories';

export const AGENT_MEMORY_RECALL_PER_SCOPE_CANDIDATES = 50;
export const AGENT_MEMORY_RELEVANCE_THRESHOLD = 0.2;
export const AGENT_MEMORY_LEXICAL_THRESHOLD = 0.18;
export const AGENT_MEMORY_LEXICAL_RELATIVE_FLOOR = 0.55;
export const AGENT_MEMORY_MMR_LAMBDA = 0.78;

const DAY_MS = 24 * 60 * 60 * 1_000;
const RECENCY_HALF_LIFE_DAYS = 365;

const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'the',
  'this', 'to', 'user', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
]);

const CHINESE_STOP_CHARACTERS = new Set([
  '的', '了', '吗', '呢', '是', '我', '你', '他', '她', '它', '请', '问', '这', '那',
]);

const NEGATION_PATTERN = /(?:\b(?:no|not|never|without|cannot|can't|don't|doesn't|isn't|wasn't|won't)\b|不|没|没有|无|未|不是|并非|取消|禁用)/iu;

type LexicalFeatures = Map<string, number>;

const normalizedText = (value: string) => value.normalize('NFKC').toLocaleLowerCase('und');

const stemLatinWord = (word: string) => {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
};

const addFeature = (features: LexicalFeatures, key: string, weight: number) => {
  features.set(key, Math.max(features.get(key) ?? 0, weight));
};

/**
 * Deterministic bilingual lexical features without a deployment-specific
 * tokenizer. Latin terms receive light suffix normalization; Han text uses
 * character bigrams plus low-weight unigrams so Chinese phrases can match even
 * when no whitespace is present.
 */
export const buildAgentMemoryLexicalFeatures = (value: string): LexicalFeatures => {
  const normalized = normalizedText(value);
  const features: LexicalFeatures = new Map();
  const hanSequences = normalized.match(/\p{Script=Han}+/gu) ?? [];
  for (const sequence of hanSequences) {
    const characters = [...sequence];
    for (const character of characters) {
      if (!CHINESE_STOP_CHARACTERS.has(character)) addFeature(features, `h1:${character}`, 0.25);
    }
    for (let index = 0; index < characters.length - 1; index += 1) {
      addFeature(features, `h2:${characters[index]}${characters[index + 1]}`, 1.5);
    }
  }

  const withoutHan = normalized.replace(/\p{Script=Han}+/gu, ' ');
  for (const rawWord of withoutHan.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const word = stemLatinWord(rawWord);
    if (word.length < 2 || ENGLISH_STOP_WORDS.has(word)) continue;
    addFeature(features, `w:${word}`, 1);
  }
  return features;
};

const lexicalSimilarity = (left: LexicalFeatures, right: LexicalFeatures) => {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  let leftWeight = 0;
  let union = 0;
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of keys) {
    const leftValue = left.get(key) ?? 0;
    const rightValue = right.get(key) ?? 0;
    intersection += Math.min(leftValue, rightValue);
    union += Math.max(leftValue, rightValue);
    leftWeight += leftValue;
  }
  if (leftWeight === 0 || union === 0) return 0;
  const queryCoverage = intersection / leftWeight;
  const weightedJaccard = intersection / union;
  return Math.min(1, queryCoverage * 0.7 + weightedJaccard * 0.3);
};

export const agentMemoryLexicalSimilarity = (query: string, content: string) => (
  lexicalSimilarity(
    buildAgentMemoryLexicalFeatures(query),
    buildAgentMemoryLexicalFeatures(content),
  )
);

const trustScore = (
  trust: AgentMemorySourceTrust,
  verificationStatus?: AgentMemoryRow['verification_status'],
) => {
  if (verificationStatus === 'user_confirmed') return 1;
  if (trust === 'user_stated') return 1;
  if (trust === 'agent_inferred') return 0.65;
  return 0.25;
};

const confidenceScore = (memory: AgentMemoryRow) => {
  const confidence = Number(memory.confidence);
  return Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5;
};

const recencyScore = (memory: AgentMemoryRow, nowMs: number) => {
  const timestamp = Date.parse(memory.created_at);
  if (!Number.isFinite(timestamp)) return 0.5;
  const ageDays = Math.max(0, nowMs - timestamp) / DAY_MS;
  return 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS);
};

const semanticScore = (
  memory: AgentMemoryRow,
  queryEmbedding?: { vector: number[]; model: string } | null,
) => {
  if (!queryEmbedding
    || !memory.embedding
    || memory.embedding_model !== queryEmbedding.model) return null;
  const similarity = cosineSimilarity(memory.embedding, queryEmbedding.vector);
  return similarity === null ? null : Math.min(1, Math.max(0, similarity));
};

interface ScoredMemory {
  memory: AgentMemoryRow;
  originalIndex: number;
  lexical: number;
  semantic: number | null;
  trust: number;
  confidence: number;
  recency: number;
  relevance: number;
  conflictPenalty: number;
  features: LexicalFeatures;
  polarity: 'negative' | 'positive';
}

const baseRelevance = (entry: Omit<ScoredMemory, 'relevance' | 'conflictPenalty'>) => {
  if (entry.semantic !== null) {
    return entry.semantic * 0.55
      + entry.lexical * 0.27
      + entry.trust * 0.08
      + entry.confidence * 0.06
      + entry.recency * 0.04;
  }
  return entry.lexical * 0.68
    + entry.trust * 0.14
    + entry.confidence * 0.1
    + entry.recency * 0.08;
};

const authorityScore = (entry: ScoredMemory) => (
  entry.trust * 0.55 + entry.confidence * 0.25 + entry.recency * 0.2
);

const applyConflictDemotions = (entries: ScoredMemory[]) => {
  let demotions = 0;
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      if (left.polarity === right.polarity) continue;
      if (lexicalSimilarity(left.features, right.features) < 0.55) continue;
      const leftAuthority = authorityScore(left);
      const rightAuthority = authorityScore(right);
      const loser = leftAuthority < rightAuthority
        || (leftAuthority === rightAuthority && left.originalIndex > right.originalIndex)
        ? left
        : right;
      if (loser.conflictPenalty < 0.16) {
        loser.conflictPenalty = 0.16;
        demotions += 1;
      }
    }
  }
  return demotions;
};

const pairwiseRedundancy = (left: ScoredMemory, right: ScoredMemory) => {
  const lexical = lexicalSimilarity(left.features, right.features);
  if (!left.memory.embedding
    || !right.memory.embedding
    || !left.memory.embedding_model
    || left.memory.embedding_model !== right.memory.embedding_model) return lexical;
  const semantic = cosineSimilarity(left.memory.embedding, right.memory.embedding);
  return semantic === null ? lexical : Math.max(lexical, Math.max(0, semantic));
};

const mmrOrder = (entries: ScoredMemory[]) => {
  const remaining = [...entries];
  const selected: ScoredMemory[] = [];
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const entry = remaining[index];
      const redundancy = selected.length === 0
        ? 0
        : Math.max(...selected.map((item) => pairwiseRedundancy(entry, item)));
      const score = AGENT_MEMORY_MMR_LAMBDA * (entry.relevance - entry.conflictPenalty)
        - (1 - AGENT_MEMORY_MMR_LAMBDA) * redundancy;
      if (score > bestScore
        || (score === bestScore && entry.originalIndex < remaining[bestIndex].originalIndex)) {
        bestIndex = index;
        bestScore = score;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
};

export type AgentMemoryRetrievalMode =
  | 'hybrid'
  | 'lexical'
  | 'no_relevant_match';

export interface AgentMemoryRetrievalResult {
  memories: AgentMemoryRow[];
  filteredMemoryIds: string[];
  mode: AgentMemoryRetrievalMode;
  consideredCount: number;
  semanticComparableCount: number;
  conflictDemotionCount: number;
}

/**
 * Hybrid Memory ranking with an explicit relevance gate and MMR diversity.
 *
 * Trust, confidence and recency may reorder relevant candidates, but they can
 * never make an unrelated row pass the gate. If no comparable embedding exists,
 * lexical matches are used. If lexical matching also has no signal, fail closed
 * with an empty result: injecting unrelated durable state is worse than omitting
 * uncertain context. Browsing without a question still uses the separate
 * deterministic_no_question path in the caller.
 */
export const retrieveAgentMemories = (
  memories: AgentMemoryRow[],
  input: {
    query: string;
    queryEmbedding?: { vector: number[]; model: string } | null;
    nowMs?: number;
  },
): AgentMemoryRetrievalResult => {
  const query = input.query.trim();
  const queryFeatures = buildAgentMemoryLexicalFeatures(query);
  const nowMs = input.nowMs ?? Date.now();
  const scored = memories.map((memory, originalIndex): ScoredMemory => {
    const features = buildAgentMemoryLexicalFeatures(memory.content);
    const partial = {
      memory,
      originalIndex,
      lexical: lexicalSimilarity(queryFeatures, features),
      semantic: semanticScore(memory, input.queryEmbedding),
      trust: trustScore(memory.source_trust, memory.verification_status),
      confidence: confidenceScore(memory),
      recency: recencyScore(memory, nowMs),
      features,
      polarity: NEGATION_PATTERN.test(normalizedText(memory.content))
        ? 'negative' as const
        : 'positive' as const,
    };
    return {
      ...partial,
      relevance: baseRelevance(partial),
      conflictPenalty: 0,
    };
  });
  const semanticComparableCount = scored.filter((entry) => entry.semantic !== null).length;
  const strongestLexicalScore = scored.reduce(
    (strongest, entry) => Math.max(strongest, entry.lexical),
    0,
  );
  // An absolute threshold alone admits generic overlaps such as “数据库” or
  // “用户偏好” even when another candidate is far more specific. The relative
  // floor keeps a weak but sole match, while rejecting low-coverage tails when
  // the same query has a clearly stronger lexical answer.
  const lexicalFloor = Math.max(
    AGENT_MEMORY_LEXICAL_THRESHOLD,
    strongestLexicalScore * AGENT_MEMORY_LEXICAL_RELATIVE_FLOOR,
  );
  const lexicalMatches = scored.filter((entry) => entry.lexical >= lexicalFloor);

  if (semanticComparableCount === 0 && lexicalMatches.length === 0) {
    return {
      memories: [],
      filteredMemoryIds: memories.map((memory) => memory.id),
      mode: 'no_relevant_match',
      consideredCount: memories.length,
      semanticComparableCount: 0,
      conflictDemotionCount: 0,
    };
  }

  const relevant = semanticComparableCount > 0
    ? scored.filter((entry) => (
      (entry.semantic ?? 0) >= AGENT_MEMORY_RELEVANCE_THRESHOLD
        || entry.lexical >= lexicalFloor
    ))
    : lexicalMatches;
  const relevantIds = new Set(relevant.map((entry) => entry.memory.id));
  const conflictDemotionCount = applyConflictDemotions(relevant);
  return {
    memories: mmrOrder(relevant).map((entry) => entry.memory),
    filteredMemoryIds: memories
      .filter((memory) => !relevantIds.has(memory.id))
      .map((memory) => memory.id),
    mode: semanticComparableCount > 0 ? 'hybrid' : 'lexical',
    consideredCount: memories.length,
    semanticComparableCount,
    conflictDemotionCount,
  };
};

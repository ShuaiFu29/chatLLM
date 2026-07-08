export interface RagDocument {
  id?: string;
  content?: string;
  metadata?: {
    filename?: string;
    file_id?: string;
    chunk_index?: number;
    retrieval_mode?: string;
  };
  similarity?: number;
  agentic_score?: number;
  matched_queries?: string[];
}

export interface ChatSource {
  chunk_id?: string;
  file_id?: string;
  filename: string;
  chunk_index?: number;
  similarity: number;
  content: string;
}

export type AnswerGroundingStatus = 'supported' | 'partial' | 'unsupported' | 'not_applicable';

export interface AnswerGroundingVerification {
  status: AnswerGroundingStatus;
  score: number;
  supported_source_count: number;
  verified_sources: ChatSource[];
  reasons: string[];
}

export interface RagTraceStep {
  step_type: 'query_rewrite' | 'retrieve' | 'rerank' | 'evidence_check' | string;
  status: 'success' | 'partial' | 'failed' | string;
  duration_ms: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface RagQualitySummary {
  retrieval_score: number;
  citation_score: number;
  evidence_score: number;
  overall_score: number;
  evidence_label: 'strong' | 'partial' | 'weak' | string;
  support_label?: 'supported' | 'partial' | 'unsupported' | string;
  verification_score?: number;
  risk_level?: 'low' | 'medium' | 'high' | string;
  risk_factors?: string[];
  missing_markers?: string[];
  matched_markers?: string[];
  answer_grounding_status?: AnswerGroundingStatus;
  answer_grounding_score?: number;
}

export interface RagTraceSummary {
  mode: string;
  intent?: {
    type: string;
    complexity: string;
    routes: string[];
  };
  planned_queries: string[];
  trace_steps: RagTraceStep[];
  quality: RagQualitySummary;
  insufficient_evidence?: boolean;
  answer_guidance?: string;
  answer_grounding?: AnswerGroundingVerification;
  cache?: {
    status: string;
    hit_type?: string;
    scope_fingerprint?: string;
    reused_count?: number;
  };
}

const MAX_SOURCE_SNIPPET_LENGTH = 500;
const MAX_RAG_CONTEXT_LENGTH = 12000;

const normalizeSnippet = (content = '') => {
  const normalized = content.trim().replace(/\s+/g, ' ');
  if (normalized.length <= MAX_SOURCE_SNIPPET_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SOURCE_SNIPPET_LENGTH)}...`;
};

export const buildChatSources = (documents: RagDocument[]): ChatSource[] => {
  return documents
    .filter((doc) => doc.metadata?.retrieval_mode !== 'metadata_inventory')
    .map((doc) => ({
      chunk_id: doc.id,
      file_id: doc.metadata?.file_id,
      filename: doc.metadata?.filename || 'Unknown source',
      chunk_index: doc.metadata?.chunk_index,
      similarity: typeof doc.similarity === 'number' ? doc.similarity : 0,
      content: normalizeSnippet(doc.content),
    }));
};

export const buildRagContextText = (documents: RagDocument[], maxLength = MAX_RAG_CONTEXT_LENGTH) => {
  const sections: string[] = [];
  let usedLength = 0;

  documents.forEach((doc) => {
      const content = String(doc.content || '').trim();
      if (!content) return;

      const sourceNumber = sections.length + 1;
      const filename = doc.metadata?.filename || 'Unknown source';
      const isInventory = doc.metadata?.retrieval_mode === 'metadata_inventory';
      const chunkNumber = typeof doc.metadata?.chunk_index === 'number'
        ? doc.metadata.chunk_index + 1
        : undefined;
      const score = !isInventory && typeof doc.similarity === 'number'
        ? `, similarity ${Math.round(doc.similarity * 100)}%`
        : '';
      const header = isInventory
        ? `[Inventory ${sourceNumber}] ${filename}`
        : `[Source ${sourceNumber}] ${filename}${chunkNumber ? `, chunk #${chunkNumber}` : ''}${score}`;
      const remaining = maxLength - usedLength - header.length - 2;
      if (remaining <= 0) return;

      const body = content.length > remaining ? `${content.slice(0, Math.max(0, remaining - 3))}...` : content;
      const section = `${header}\n${body}`;
      sections.push(section);
      usedLength += section.length + 2;
    });

  return sections.join('\n\n---\n\n');
};

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'about',
  'should',
  'would',
  'could',
  '用户',
  '文档',
  '资料',
  '回答',
  '问题',
  '可以',
  '需要',
  '应该',
  '不能',
  '不是',
  '以及',
]);

const clampScore = (value: number) => Math.max(0, Math.min(1, Number(value.toFixed(4))));

const extractMarkers = (value = '') => {
  const markers = new Set<string>();
  const markerPattern = /\b[A-Z]{2,}\b|\b[A-Z]+-?\d+\b|\bT\+\d+\b|\b(?:19|20)\d{2}\b/gi;
  for (const match of value.matchAll(markerPattern)) {
    markers.add(match[0].replace(/\s+/g, '').toUpperCase());
  }
  return markers;
};

const addCjkShingles = (terms: Set<string>, token: string) => {
  const compact = token.replace(/\s+/g, '');
  for (const size of [2, 3, 4]) {
    if (compact.length < size) continue;
    for (let index = 0; index <= compact.length - size; index += 1) {
      const shingle = compact.slice(index, index + size);
      if (!STOPWORDS.has(shingle)) terms.add(shingle);
    }
  }
};

const extractGroundingTerms = (value = '') => {
  const terms = new Set<string>();
  const normalized = value.toLowerCase();

  for (const token of normalized.match(/[a-z0-9][a-z0-9-]{2,}/g) || []) {
    const compact = token.replace(/^-+|-+$/g, '');
    if (compact && !STOPWORDS.has(compact)) terms.add(compact);
  }

  for (const token of value.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    addCjkShingles(terms, token);
  }

  for (const marker of extractMarkers(value)) {
    terms.add(marker.toLowerCase());
  }

  return terms;
};

const overlapRatio = (left: Set<string>, right: Set<string>) => {
  if (left.size === 0 || right.size === 0) return 0;
  let matches = 0;
  for (const term of left) {
    if (right.has(term)) matches += 1;
  }
  return matches / left.size;
};

const hasCautiousInsufficientAnswer = (answer: string) => {
  const normalized = answer.toLowerCase().replace(/\s+/g, '');
  return [
    '资料不足',
    '证据不足',
    '无法确定',
    '不能确定',
    '未检索到',
    '没有足够',
    'source material is insufficient',
    'insufficient evidence',
    'cannot determine',
  ].some((marker) => normalized.includes(marker.replace(/\s+/g, '')));
};

export const verifyAnswerGrounding = (
  answer: string,
  sources: ChatSource[],
  quality?: Partial<RagQualitySummary>,
  insufficientEvidence = false
): AnswerGroundingVerification => {
  if (!sources.length) {
    return {
      status: 'not_applicable',
      score: 1,
      supported_source_count: 0,
      verified_sources: [],
      reasons: ['no_sources'],
    };
  }

  const normalizedAnswer = answer.trim();
  if (!normalizedAnswer) {
    return {
      status: 'unsupported',
      score: 0,
      supported_source_count: 0,
      verified_sources: [],
      reasons: ['empty_answer'],
    };
  }

  const answerTerms = extractGroundingTerms(normalizedAnswer);
  const answerMarkers = extractMarkers(normalizedAnswer);
  const sourceTerms = extractGroundingTerms(sources.map((source) => source.content).join('\n'));
  const sourceMarkers = extractMarkers(sources.map((source) => source.content).join('\n'));
  const answerCoverage = overlapRatio(answerTerms, sourceTerms);
  const markerCoverage = answerMarkers.size
    ? overlapRatio(answerMarkers, sourceMarkers)
    : 1;

  const scoredSources = sources.map((source) => {
    const terms = extractGroundingTerms(source.content);
    const markers = extractMarkers(source.content);
    const termScore = overlapRatio(answerTerms, terms);
    const markerScore = answerMarkers.size ? overlapRatio(answerMarkers, markers) : 0;
    const score = clampScore(termScore * 0.75 + markerScore * 0.25);
    return { source, score, markerScore };
  });

  const verifiedSources = scoredSources
    .filter(({ score, markerScore }) => score >= 0.12 || markerScore > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ source }) => source);
  const bestSourceScore = Math.max(...scoredSources.map(({ score }) => score), 0);
  const sourceSupportRatio = verifiedSources.length / sources.length;
  const score = clampScore(answerCoverage * 0.6 + markerCoverage * 0.2 + sourceSupportRatio * 0.12 + bestSourceScore * 0.08);

  const reasons: string[] = [];
  const supportLabel = String(quality?.support_label || '').toLowerCase();
  const evidenceLabel = String(quality?.evidence_label || '').toLowerCase();
  const cautious = hasCautiousInsufficientAnswer(normalizedAnswer);

  if (answerCoverage < 0.18 && verifiedSources.length === 0) reasons.push('low_answer_source_overlap');
  if (answerMarkers.size > 0 && markerCoverage < 1) reasons.push('missing_answer_markers_in_sources');
  if (supportLabel === 'unsupported' || evidenceLabel === 'weak') reasons.push('retrieval_quality_not_supported');
  if (insufficientEvidence && !cautious) reasons.push('answer_not_cautious_under_insufficient_evidence');

  let status: AnswerGroundingStatus;
  if (cautious && insufficientEvidence) {
    status = 'partial';
  } else if (
    score >= 0.32
    && verifiedSources.length > 0
    && markerCoverage >= 0.8
    && supportLabel !== 'unsupported'
    && evidenceLabel !== 'weak'
  ) {
    status = 'supported';
  } else if (score >= 0.18 && verifiedSources.length > 0 && supportLabel !== 'unsupported') {
    status = 'partial';
  } else {
    status = 'unsupported';
  }

  return {
    status,
    score,
    supported_source_count: verifiedSources.length,
    verified_sources: status === 'unsupported' ? [] : verifiedSources,
    reasons: Array.from(new Set(reasons)),
  };
};

import type { DocumentKind } from './uploadInput';

export interface SourceLocatorSheet {
  sheet?: string;
  sheet_index?: number;
}

export interface SourceLocator {
  type?: string;
  types?: string[];
  kind?: string;
  line_start?: number;
  line_end?: number;
  page?: number;
  page_start?: number;
  page_end?: number;
  block?: number;
  paragraph?: number;
  paragraph_start?: number;
  paragraph_end?: number;
  table?: number;
  table_start?: number;
  table_end?: number;
  slide?: number;
  slide_start?: number;
  slide_end?: number;
  shape?: number;
  shape_id?: number;
  heading_level?: number;
  row_start?: number;
  row_end?: number;
  column_count?: number;
  sheet?: string;
  sheet_index?: number;
  sheets?: SourceLocatorSheet[];
  locators?: SourceLocator[];
}

export interface SourceProvenance {
  document_kind?: DocumentKind;
  conversion_generation_id?: string;
  source_unit_ids?: string[];
  source_locator?: SourceLocator;
}

export interface RagDocument {
  id?: string;
  content?: string;
  metadata?: {
    filename?: string;
    file_id?: string;
    chunk_index?: number;
    retrieval_mode?: string;
    title?: string;
    heading?: string;
    section_path?: string | string[];
    heading_path?: string | string[];
    parent_id?: string;
    parent_chunk_id?: string;
    parent_title?: string;
    parent_heading?: string;
    parent_content?: string;
    context_truncated?: boolean;
    original_content_length?: number;
    document_kind?: DocumentKind;
    conversion_generation_id?: string;
    source_unit_ids?: string[];
    source_locator?: SourceLocator;
  };
  similarity?: number;
  agentic_score?: number;
  matched_queries?: string[];
  source_role?: string;
}

export interface ChatSource extends SourceProvenance {
  chunk_id?: string;
  file_id?: string;
  filename: string;
  chunk_index?: number;
  similarity: number;
  content: string;
  source_role?: string;
}

export type AnswerGroundingStatus = 'supported' | 'partial' | 'unsupported' | 'not_applicable';

export interface AnswerGroundingVerification {
  status: AnswerGroundingStatus;
  score: number;
  supported_source_count: number;
  verified_sources: ChatSource[];
  reasons: string[];
  model_cited_labels?: number[];
  pre_verification_cited_sources?: ChatSource[];
  citation_decisions?: CitationDecision[];
  auto_attributed_sources?: ChatSource[];
}

export interface CitationDecision {
  source_number: number;
  supported: boolean;
  score: number;
  reasons: string[];
  support_mode?: 'lexical';
  auto_attributed?: boolean;
}

export interface RagContextAllocation {
  source_number: number;
  chunk_id?: string;
  filename: string;
  included_chars: number;
  total_chars: number;
  truncated: boolean;
}

export interface RagContextSourceMapEntry extends SourceProvenance {
  source_number: number;
  chunk_id?: string;
  file_id?: string;
  filename: string;
  chunk_index?: number;
}

export interface RagContextBuildResult {
  text: string;
  allocations: RagContextAllocation[];
  source_map: RagContextSourceMapEntry[];
}

export interface RagAnswerContextBuildResult extends RagContextBuildResult {
  documents: RagDocument[];
  budget_tokens: number;
  estimated_tokens: number;
  truncated: boolean;
}

export interface AtomicClaimCitation {
  source_number: number;
  supported: boolean;
  score: number;
  marker_coverage: number;
  polarity_conflict: boolean;
  reasons: string[];
}

export interface AtomicClaimEvaluation {
  claim_index: number;
  text: string;
  citation_labels: number[];
  citations: AtomicClaimCitation[];
  supported: boolean;
  cited: boolean;
  deterministic_checks: {
    fact_markers: string[];
    marker_match: boolean;
    polarity_match: boolean;
  };
  reasons: string[];
}

export interface AnswerClaimEvaluation {
  verifier_version: string;
  claims: AtomicClaimEvaluation[];
  citation_precision: number;
  citation_coverage: number;
  citation_f1: number;
  hallucination_rate: number;
  abstained: boolean;
  retrieval_insufficient_evidence: boolean;
  metric_applicability: {
    claim_verification: boolean;
    citation_precision: boolean;
    citation_coverage: boolean;
    citation_f1: boolean;
    hallucination_rate: boolean;
  };
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
export const RAG_ANSWER_CONTEXT_BUDGET_TOKENS = 6000;
export const ANSWER_CLAIM_VERIFIER_VERSION = 'deterministic-claims-v1';

export const buildAnswerTaskGuidance = (question: string) => {
  const normalized = String(question || '').toLowerCase().replace(/\s+/g, '');
  const guidance = [
    'Review every provided source before drafting. If different sources contain distinct facts that directly answer the question, include and cite each relevant source rather than stopping at the first usable passage.',
    'Prefer complete factual coverage over brevity, while excluding facts that do not answer the question.',
  ];
  if (/(哪些|有哪些|包含|包括|关联|保留什么|what|which|list)/i.test(normalized)) {
    guidance.push('For list or coverage questions, enumerate every distinct directly supported item, identifier, condition, or evidence category found in the relevant sources; do not provide only representative examples.');
  }
  if (/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+(?:\.\d+)*\b/i.test(question)) {
    guidance.push('When the question explicitly names a document, version, case, or other exact identifier and several chunks from its matching source are present, inspect and synthesize all matching chunks before using more general sources.');
  }
  if (/(金额|计算|多少|小时|比例|系数|权重|得分|分数|calculate|amount|ratio|score)/i.test(normalized)) {
    guidance.push('For calculations, show the formula, inputs, units, intermediate multiplication or weighting, final result, and whether the result is preliminary, capped, conditional, or final.');
  }
  if (/(是否|能否|可以吗|必须|等于|意味着|is|can|must|does)/i.test(normalized)) {
    guidance.push('For decision questions, begin with a direct yes, no, conditional, or insufficient-evidence conclusion, then state the supporting facts, limitations, and exceptions.');
  }
  if (/(区别|不同|冲突|对比|关系|difference|compare|relationship)/i.test(normalized)) {
    guidance.push('For comparison questions, define each side and explain every material difference, relationship, scope, and evidence boundary.');
  }
  if (/(为什么|原因|如何|怎么|why|how)/i.test(normalized)) {
    guidance.push('For why/how questions, state the conclusion and cover each distinct causal factor, required step, constraint, and exception supported by the sources.');
  }
  if (/(哪些文件|哪些材料|哪些来源|文件说明|材料共同|whichfiles|whichdocuments)/i.test(normalized)) {
    guidance.push('For source-set questions, name each directly relevant source and explain the unique role it plays in supporting the conclusion.');
  }
  return guidance.join('\n');
};

const normalizeSnippet = (content = '') => {
  const normalized = content.trim().replace(/\s+/g, ' ');
  if (normalized.length <= MAX_SOURCE_SNIPPET_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SOURCE_SNIPPET_LENGTH)}...`;
};

const DOCUMENT_KINDS = new Set<DocumentKind>([
  'markdown',
  'plaintext',
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'csv',
]);

const optionalString = (value: unknown) => (
  typeof value === 'string' && value.trim() ? value : undefined
);

const optionalFiniteNumber = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const SOURCE_LOCATOR_STRING_FIELDS = ['type', 'kind', 'sheet'] as const;
const SOURCE_LOCATOR_NUMBER_FIELDS = [
  'line_start',
  'line_end',
  'page',
  'page_start',
  'page_end',
  'block',
  'paragraph',
  'paragraph_start',
  'paragraph_end',
  'table',
  'table_start',
  'table_end',
  'slide',
  'slide_start',
  'slide_end',
  'shape',
  'shape_id',
  'heading_level',
  'row_start',
  'row_end',
  'column_count',
  'sheet_index',
] as const;

const normalizeSourceLocator = (value: unknown, depth = 0): SourceLocator | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const locator: SourceLocator = {};
  for (const field of SOURCE_LOCATOR_STRING_FIELDS) {
    const fieldValue = optionalString(source[field]);
    if (fieldValue) locator[field] = fieldValue;
  }
  for (const field of SOURCE_LOCATOR_NUMBER_FIELDS) {
    const fieldValue = optionalFiniteNumber(source[field]);
    if (fieldValue !== undefined) locator[field] = fieldValue;
  }

  if (Array.isArray(source.types)) {
    const types = source.types.map(optionalString).filter((item): item is string => Boolean(item));
    if (types.length > 0) locator.types = types;
  }
  if (Array.isArray(source.sheets)) {
    const sheets: SourceLocatorSheet[] = [];
    for (const value of source.sheets) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const rawSheet = value as Record<string, unknown>;
      const sheet = optionalString(rawSheet.sheet);
      const sheetIndex = optionalFiniteNumber(rawSheet.sheet_index);
      if (sheet || sheetIndex !== undefined) {
        sheets.push({
          ...(sheet ? { sheet } : {}),
          ...(sheetIndex !== undefined ? { sheet_index: sheetIndex } : {}),
        });
      }
    }
    if (sheets.length > 0) locator.sheets = sheets;
  }
  if (depth === 0 && Array.isArray(source.locators)) {
    const locators = source.locators
      .map((item) => normalizeSourceLocator(item, depth + 1))
      .filter((item): item is SourceLocator => Boolean(item));
    if (locators.length > 0) locator.locators = locators;
  }

  return Object.keys(locator).length > 0 ? locator : undefined;
};

const buildSourceProvenance = (metadata: RagDocument['metadata']): SourceProvenance => {
  if (!metadata) return {};
  const documentKind = DOCUMENT_KINDS.has(metadata.document_kind as DocumentKind)
    ? metadata.document_kind as DocumentKind
    : undefined;
  const conversionGenerationId = optionalString(metadata.conversion_generation_id);
  const sourceUnitIds = Array.isArray(metadata.source_unit_ids)
    ? metadata.source_unit_ids.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : undefined;
  const sourceLocator = normalizeSourceLocator(metadata.source_locator);
  return {
    ...(documentKind ? { document_kind: documentKind } : {}),
    ...(conversionGenerationId ? { conversion_generation_id: conversionGenerationId } : {}),
    ...(sourceUnitIds ? { source_unit_ids: sourceUnitIds } : {}),
    ...(sourceLocator ? { source_locator: sourceLocator } : {}),
  };
};

export const buildChatSources = (documents: RagDocument[]): ChatSource[] => {
  return documents
    .filter((doc) => doc.metadata?.retrieval_mode !== 'metadata_inventory' && String(doc.content || '').trim())
    .map((doc) => ({
      chunk_id: doc.id,
      file_id: doc.metadata?.file_id,
      filename: doc.metadata?.filename || 'Unknown source',
      chunk_index: doc.metadata?.chunk_index,
      similarity: typeof doc.similarity === 'number' ? doc.similarity : 0,
      content: normalizeSnippet(doc.content),
      ...buildSourceProvenance(doc.metadata),
      ...(doc.source_role ? { source_role: doc.source_role } : {}),
    }));
};

export const buildVerificationSources = (documents: RagDocument[]): ChatSource[] => documents
  .filter((doc) => doc.metadata?.retrieval_mode !== 'metadata_inventory' && String(doc.content || '').trim())
  .map((doc) => ({
    chunk_id: doc.id,
    file_id: doc.metadata?.file_id,
    filename: doc.metadata?.filename || 'Unknown source',
    chunk_index: doc.metadata?.chunk_index,
    similarity: typeof doc.similarity === 'number' ? doc.similarity : 0,
    content: String(doc.content || '').trim(),
    ...buildSourceProvenance(doc.metadata),
    ...(doc.source_role ? { source_role: doc.source_role } : {}),
  }));

export const buildRagContext = (
  documents: RagDocument[],
  maxLength = MAX_RAG_CONTEXT_LENGTH
): RagContextBuildResult => {
  const entries = documents
    .map((doc) => ({ doc, content: String(doc.content || '').trim() }))
    .filter(({ content }) => content.length > 0)
    .map(({ doc, content }, index) => {
      const sourceNumber = index + 1;
      const filename = doc.metadata?.filename || 'Unknown source';
      const isInventory = doc.metadata?.retrieval_mode === 'metadata_inventory';
      const chunkNumber = typeof doc.metadata?.chunk_index === 'number'
        ? doc.metadata.chunk_index + 1
        : undefined;
      const score = !isInventory && typeof doc.similarity === 'number'
        ? `, similarity ${Math.round(doc.similarity * 100)}%`
        : '';
      const authority = doc.source_role === 'evaluation_guide'
        ? ' [role: evaluation guide; navigation only, not sufficient primary business evidence]'
        : doc.source_role === 'index'
          ? ' [role: index; navigation only, not sufficient primary business evidence]'
          : '';
      const header = isInventory
        ? `[Inventory ${sourceNumber}] ${filename}`
        : `[Source ${sourceNumber}] ${filename}${chunkNumber ? `, chunk #${chunkNumber}` : ''}${score}${authority}`;
      return { doc, content, sourceNumber, filename, header, included: 0 };
    });

  if (entries.length === 0 || maxLength <= 0) return { text: '', allocations: [], source_map: [] };
  const separator = '\n\n---\n\n';
  const fixedLength = entries.reduce((sum, entry) => sum + entry.header.length + 1, 0)
    + separator.length * Math.max(0, entries.length - 1);
  const bodyBudget = Math.max(0, maxLength - fixedLength);
  const fairShare = Math.floor(bodyBudget / entries.length);

  for (const entry of entries) entry.included = Math.min(entry.content.length, fairShare);
  let remaining = bodyBudget - entries.reduce((sum, entry) => sum + entry.included, 0);
  for (const entry of entries) {
    if (remaining <= 0) break;
    const extra = Math.min(remaining, entry.content.length - entry.included);
    entry.included += extra;
    remaining -= extra;
  }

  const includedEntries = entries.filter((entry) => entry.included > 0);
  const text = includedEntries
    .map((entry) => `${entry.header}\n${entry.content.slice(0, entry.included)}`)
    .join(separator)
    .slice(0, maxLength);
  const allocations = entries.map((entry) => ({
    source_number: entry.sourceNumber,
    chunk_id: entry.doc.id,
    filename: entry.filename,
    included_chars: entry.included,
    total_chars: entry.content.length,
    truncated: entry.included < entry.content.length,
  }));
  const source_map = entries
    .filter((entry) => entry.doc.metadata?.retrieval_mode !== 'metadata_inventory')
    .map((entry) => ({
      source_number: entry.sourceNumber,
      chunk_id: entry.doc.id,
      file_id: entry.doc.metadata?.file_id,
      filename: entry.filename,
      chunk_index: entry.doc.metadata?.chunk_index,
      ...buildSourceProvenance(entry.doc.metadata),
    }));
  return { text, allocations, source_map };
};

export const buildRagContextText = (documents: RagDocument[], maxLength = MAX_RAG_CONTEXT_LENGTH) => (
  buildRagContext(documents, maxLength).text
);

export const estimateRagTokens = (value: string = ''): number => {
  const cjkCount = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjk = value.replace(/[\u3400-\u9fff]/g, ' ');
  const latinWordTokens = (nonCjk.match(/[A-Za-z0-9]+(?:[-_.:/][A-Za-z0-9]+)*/g) || [])
    .reduce<number>((sum, token) => sum + Math.max(1, Math.ceil(token.length / 4)), 0);
  const punctuationTokens = Math.ceil((nonCjk.match(/[^\sA-Za-z0-9]/g) || []).length / 2);
  return cjkCount + latinWordTokens + punctuationTokens;
};

const truncateToEstimatedTokens = (value: string, tokenBudget: number) => {
  if (tokenBudget <= 0) return '';
  if (estimateRagTokens(value) <= tokenBudget) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateRagTokens(value.slice(0, middle)) <= tokenBudget) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low).trimEnd();
};

const normalizedSectionPath = (metadata: RagDocument['metadata']) => {
  const value = metadata?.section_path || metadata?.heading_path;
  if (Array.isArray(value)) return value.filter(Boolean).join(' > ');
  return String(value || '').trim();
};

const answerContextBody = (document: RagDocument) => {
  const content = String(document.content || '').trim();
  const parentContent = String(document.metadata?.parent_content || '').trim();
  if (!parentContent || parentContent.includes(content)) return content;
  return `Parent context:\n${parentContent.slice(0, 2000)}\n\nRetrieved passage:\n${content}`;
};

const diversifyAndDeduplicateDocuments = (documents: RagDocument[]) => {
  const seenIdentity = new Set<string>();
  const seenContent = new Set<string>();
  const groups = new Map<string, RagDocument[]>();
  for (const document of documents) {
    const content = String(document.content || '').trim();
    if (!content) continue;
    const identity = document.id
      || `${document.metadata?.file_id || ''}:${document.metadata?.chunk_index ?? ''}:${content.slice(0, 120)}`;
    const normalizedContent = content.toLowerCase().replace(/\s+/g, ' ');
    if (seenIdentity.has(identity) || seenContent.has(normalizedContent)) continue;
    seenIdentity.add(identity);
    seenContent.add(normalizedContent);
    const sourceKey = document.metadata?.file_id || document.metadata?.filename || identity;
    const group = groups.get(sourceKey) || [];
    group.push(document);
    groups.set(sourceKey, group);
  }

  const diversified: RagDocument[] = [];
  const queues = [...groups.values()];
  while (queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const document = queue.shift();
      if (document) diversified.push(document);
    }
  }
  return diversified;
};

export const packRagAnswerContext = (
  documents: RagDocument[],
  budgetTokens = RAG_ANSWER_CONTEXT_BUDGET_TOKENS
): RagAnswerContextBuildResult => {
  const boundedBudget = Math.max(1, Math.floor(budgetTokens));
  const diversified = diversifyAndDeduplicateDocuments(documents);
  let sourceNumber = 0;
  let inventoryNumber = 0;
  const entries = diversified.map((document) => {
    const isInventory = document.metadata?.retrieval_mode === 'metadata_inventory';
    const labelNumber = isInventory ? ++inventoryNumber : ++sourceNumber;
    const filename = document.metadata?.filename || 'Unknown source';
    const heading = document.metadata?.heading || document.metadata?.title || normalizedSectionPath(document.metadata);
    const parent = document.metadata?.parent_heading
      || document.metadata?.parent_title
      || document.metadata?.parent_chunk_id
      || document.metadata?.parent_id;
    const chunkNumber = typeof document.metadata?.chunk_index === 'number'
      ? document.metadata.chunk_index + 1
      : undefined;
    const authority = document.source_role === 'evaluation_guide'
      ? ' [role: evaluation guide; navigation only, not sufficient primary business evidence]'
      : document.source_role === 'index'
        ? ' [role: index; navigation only, not sufficient primary business evidence]'
        : '';
    const metadataSuffix = [
      chunkNumber ? `chunk #${chunkNumber}` : '',
      heading ? `section: ${heading}` : '',
      parent ? `parent: ${parent}` : '',
    ].filter(Boolean).join(', ');
    const header = isInventory
      ? `[Inventory ${labelNumber}] ${filename}${metadataSuffix ? `, ${metadataSuffix}` : ''}`
      : `[Source ${labelNumber}] ${filename}${metadataSuffix ? `, ${metadataSuffix}` : ''}${authority}`;
    return {
      document,
      isInventory,
      labelNumber,
      filename,
      header,
      body: answerContextBody(document),
      included: '',
    };
  });

  if (entries.length === 0) {
    return {
      text: '',
      allocations: [],
      source_map: [],
      documents: [],
      budget_tokens: boundedBudget,
      estimated_tokens: 0,
      truncated: false,
    };
  }

  const separator = '\n\n---\n\n';
  const separatorTokens = estimateRagTokens(separator);
  const selectedEntries: typeof entries = [];
  let reservedTokens = 0;
  for (const entry of entries) {
    const headerTokens = estimateRagTokens(`${entry.header}\n`);
    const minimumBodyTokens = Math.min(
      estimateRagTokens(entry.body),
      entry.isInventory ? 12 : 32,
    );
    const requiredTokens = headerTokens
      + (selectedEntries.length > 0 ? separatorTokens : 0)
      + minimumBodyTokens;
    if (selectedEntries.length > 0 && reservedTokens + requiredTokens > boundedBudget) break;
    if (reservedTokens + headerTokens >= boundedBudget) break;
    selectedEntries.push(entry);
    reservedTokens += requiredTokens;
  }

  const fixedTokens = selectedEntries.reduce<number>(
    (sum, entry) => sum + estimateRagTokens(`${entry.header}\n`),
    0,
  ) + separatorTokens * Math.max(0, selectedEntries.length - 1);
  const bodyBudget = Math.max(0, boundedBudget - fixedTokens);
  const tokenAllocations = selectedEntries.map((entry) => Math.min(
    estimateRagTokens(entry.body),
    entry.isInventory ? 12 : 32,
  ));
  let remainingTokens = Math.max(0, bodyBudget - tokenAllocations.reduce((sum, value) => sum + value, 0));
  const weights = selectedEntries.map((entry) => {
    const score = entry.document.agentic_score ?? entry.document.similarity ?? 0;
    return Number.isFinite(score) && score > 0 ? score : 0.1;
  });
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const weightedBudget = remainingTokens;
  selectedEntries.forEach((entry, index) => {
    const required = Math.max(0, estimateRagTokens(entry.body) - tokenAllocations[index]);
    const share = Math.min(required, Math.floor(weightedBudget * (weights[index] / totalWeight)));
    tokenAllocations[index] += share;
    remainingTokens -= share;
  });
  for (let index = 0; index < selectedEntries.length && remainingTokens > 0; index += 1) {
    const required = Math.max(0, estimateRagTokens(selectedEntries[index].body) - tokenAllocations[index]);
    const extra = Math.min(required, remainingTokens);
    tokenAllocations[index] += extra;
    remainingTokens -= extra;
  }
  selectedEntries.forEach((entry, index) => {
    entry.included = truncateToEstimatedTokens(entry.body, tokenAllocations[index]);
  });

  const includedEntries = entries.filter((entry) => entry.included.length > 0);
  const text = includedEntries.map((entry) => `${entry.header}\n${entry.included}`).join(separator);
  const packedDocuments = includedEntries.map((entry) => ({
    ...entry.document,
    content: entry.included,
    metadata: {
      ...entry.document.metadata,
      context_truncated: entry.included.length < entry.body.length,
      original_content_length: entry.body.length,
    },
  }));
  const allocations = entries.map((entry) => ({
    source_number: entry.labelNumber,
    chunk_id: entry.document.id,
    filename: entry.filename,
    included_chars: entry.included.length,
    total_chars: entry.body.length,
    truncated: entry.included.length < entry.body.length,
  }));
  const source_map = includedEntries
    .filter((entry) => !entry.isInventory)
    .map((entry) => ({
      source_number: entry.labelNumber,
      chunk_id: entry.document.id,
      file_id: entry.document.metadata?.file_id,
      filename: entry.filename,
      chunk_index: entry.document.metadata?.chunk_index,
      ...buildSourceProvenance(entry.document.metadata),
    }));
  return {
    text,
    allocations,
    source_map,
    documents: packedDocuments,
    budget_tokens: boundedBudget,
    estimated_tokens: estimateRagTokens(text),
    truncated: allocations.some((entry) => entry.truncated) || packedDocuments.length < diversified.length,
  };
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
  const markerPattern = /\b[A-Z]{2,}\b|\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+(?:\.\d+)*\b|\b[A-Z]+-?\d+(?:\.\d+)+\b|\bT\+\d+\b|\b(?:19|20)\d{2}\b/g;
  for (const match of value.matchAll(markerPattern)) {
    markers.add(match[0].replace(/\s+/g, '').toUpperCase());
  }
  return markers;
};

const extractFactMarkers = (value = '') => {
  const withoutCitations = value.replace(/\[\s*Source\s+\d+\s*\]/gi, ' ');
  const markers = extractMarkers(withoutCitations);
  for (const match of withoutCitations.matchAll(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g)) {
    const raw = match[0];
    const number = Number(raw.replace(/,/g, '').replace(/%$/, ''));
    if (Number.isFinite(number)) markers.add(`${raw.endsWith('%') ? 'PCT' : 'NUM'}:${number}`);
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
    '不足以',
    '不能回答',
    '无法回答',
    '无法全面',
    'source material is insufficient',
    'insufficient evidence',
    'cannot determine',
    'cannot fully',
    'insufficient to',
  ].some((marker) => normalized.includes(marker.replace(/\s+/g, '')));
};

const sourceIdentity = (source: ChatSource) => (
  source.chunk_id || `${source.file_id || ''}:${source.filename}:${source.chunk_index ?? ''}`
);

const citedClaims = (answer: string) => {
  const claims: Array<{ sourceNumber: number; claim: string }> = [];
  const pattern = /\[\s*Source\s+(\d+)\s*\]/gi;
  for (const match of answer.matchAll(pattern)) {
    const sourceNumber = Number(match[1]);
    const before = answer.slice(0, match.index).replace(/[\s。！？!?；;]+$/g, '');
    const boundary = Math.max(
      before.lastIndexOf('\n'),
      before.lastIndexOf('。'),
      before.lastIndexOf('！'),
      before.lastIndexOf('？'),
      before.lastIndexOf(';'),
      before.lastIndexOf('；')
    );
    const precedingClaim = before.slice(boundary + 1)
      .replace(/\[\s*Source\s+\d+\s*\]/gi, '')
      .replace(/^\s*\d+[.)、]\s*/, '')
      .trim();
    const rawAfter = answer.slice((match.index || 0) + match[0].length);
    const citationIntroducesFollowing = /^(?:中的(?:信息|表格|说明|内容)?|中|显示|指出|提到|也提到|明确指出|明确说明|也强调|states?\b|indicates?\b|shows?\b|notes?\b|explains?\b|says?\b|reports?\b|according\s+to\b)/i.test(rawAfter.trimStart());
    const after = rawAfter
      .replace(/^(?:中的(?:信息|表格|说明|内容)?|中|显示|指出|提到|明确指出|明确说明|也强调|states?\b|indicates?\b|shows?\b|notes?\b|explains?\b|says?\b|reports?\b|according\s+to\b)[\s，,:：]*/i, '');
    const followingBoundary = after.search(/[。！？!?；;\n]|\[\s*Source\s+\d+\s*\]/i);
    const followingClaim = after.slice(0, followingBoundary < 0 ? after.length : followingBoundary)
      .replace(/^[\s，,:：和及]+/, '')
      .trim();
    const precedingCompact = precedingClaim.replace(/[\s，,:：]/g, '');
    const useFollowing = citationIntroducesFollowing || precedingCompact.length < 8
      || /^(根据|参见|来自|结合|同时|以及|和|及|来源)$/.test(precedingCompact);
    const metaCitation = /^(?:这个|上述|该)?(?:公式|结论|信息|内容).*(?:来源于|来自|见)$/.test(precedingCompact);
    const previousClaims = before.slice(0, Math.max(0, boundary))
      .split(/[。！？!?；;\n]+/)
      .map((item) => item.replace(/\[\s*Source\s+\d+\s*\]/gi, '').trim())
      .filter(Boolean);
    const claim = metaCitation && previousClaims.length
      ? previousClaims[previousClaims.length - 1]
      : useFollowing && followingClaim ? followingClaim : precedingClaim;
    claims.push({ sourceNumber, claim });
  }
  return claims;
};

const uncitedSubstantiveClaims = (answer: string) => String(answer || '')
  .replace(/([。！？!?；;])\s*(\[\s*Source\s+\d+\s*\])/gi, '$2$1')
  .split(/[。！？!?；;\n]+/)
  .map((item) => item.replace(/^\s*\d+[.)、]\s*/, '').trim())
  .filter((item) => item.length >= 12 && !/\[\s*Source\s+\d+\s*\]/i.test(item));

const clausePolarity = (value: string) => {
  const normalized = value.toLowerCase().replace(/\s+/g, '');
  const negative = /不一定|不自动|不等于|不代表|不证明|不说明|不构成|不建议|不是|不能|无法|不可以|不可|不得|不应|没有|不足|未曾|并未|未|not|cannot|can't|isn't|hasn't|haven't|insufficient|without/.test(normalized);
  const positive = /可以|能够|等于|已经|批准|必须|应当|需要|确认|承认|优先|是|can|must|should|required|approved|confirmed|completed/.test(normalized);
  if (negative && !positive) return 'negative';
  if (positive && !negative) return 'positive';
  return 'unknown';
};

const citationPolarityConflict = (claim: string, sourceContent: string) => {
  const claimPolarity = clausePolarity(claim);
  if (claimPolarity === 'unknown') return false;
  const claimTerms = extractGroundingTerms(claim);
  let bestClause = '';
  let bestOverlap = 0;
  for (const clause of sourceContent.split(/[。！？!?；;\n]+/)) {
    const overlap = overlapRatio(claimTerms, extractGroundingTerms(clause));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestClause = clause;
    }
  }
  const sourcePolarity = clausePolarity(bestClause);
  return bestOverlap >= 0.6
    && sourcePolarity !== 'unknown'
    && sourcePolarity !== claimPolarity;
};

const splitAtomicClaims = (answer: string) => String(answer || '')
  .replace(/([。！？!?；;])\s*(\[\s*Source\s+\d+\s*\])/gi, '$2$1')
  .split(/[。！？!?；;\n]+|\.(?=\s+|$)/)
  .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
  .filter((item) => item.length >= 4 && !/^#{1,6}\s*\S+$/.test(item));

const evaluateClaimAgainstSource = (claim: string, source: ChatSource | undefined, sourceNumber: number) => {
  if (!source) {
    return {
      source_number: sourceNumber,
      supported: false,
      score: 0,
      marker_coverage: 0,
      polarity_conflict: false,
      reasons: ['invalid_citation_label'],
    } satisfies AtomicClaimCitation;
  }
  const evidence = `${source.filename}\n${source.content}`;
  const claimTerms = extractGroundingTerms(claim);
  const factMarkers = extractFactMarkers(claim);
  const termScore = overlapRatio(claimTerms, extractGroundingTerms(evidence));
  const markerCoverage = factMarkers.size
    ? overlapRatio(factMarkers, extractFactMarkers(evidence))
    : 1;
  const polarityConflict = citationPolarityConflict(claim, evidence);
  const minimumTermScore = factMarkers.size > 0 ? 0.08 : 0.12;
  const reasons: string[] = [];
  if (termScore < minimumTermScore) reasons.push('claim_not_supported');
  if (markerCoverage < 1) reasons.push('fact_marker_mismatch');
  if (polarityConflict) reasons.push('polarity_mismatch');
  return {
    source_number: sourceNumber,
    supported: reasons.length === 0,
    score: clampScore(termScore * 0.75 + markerCoverage * 0.25),
    marker_coverage: clampScore(markerCoverage),
    polarity_conflict: polarityConflict,
    reasons,
  } satisfies AtomicClaimCitation;
};

export const evaluateAnswerClaims = (
  answer: string,
  sources: ChatSource[],
  insufficientEvidence = false
): AnswerClaimEvaluation => {
  const claims = splitAtomicClaims(answer).map((rawClaim, index) => {
    const citationLabels = [...new Set([...rawClaim.matchAll(/\[\s*Source\s+(\d+)\s*\]/gi)]
      .map((match) => Number(match[1])))]
      .filter((sourceNumber) => Number.isInteger(sourceNumber) && sourceNumber > 0);
    const claim = rawClaim.replace(/\[\s*Source\s+\d+\s*\]/gi, '').trim();
    const citedEvaluations = citationLabels.map((sourceNumber) => (
      evaluateClaimAgainstSource(claim, sources[sourceNumber - 1], sourceNumber)
    ));
    const candidateEvaluations = citationLabels.length > 0
      ? citedEvaluations
      : sources.map((source, sourceIndex) => evaluateClaimAgainstSource(claim, source, sourceIndex + 1));
    const bestEvaluation = candidateEvaluations.reduce<AtomicClaimCitation | undefined>(
      (best, current) => !best || current.score > best.score ? current : best,
      undefined
    );
    const cautiousInsufficientClaim = insufficientEvidence && hasCautiousInsufficientAnswer(claim);
    const supported = cautiousInsufficientClaim || Boolean(bestEvaluation?.supported);
    const factMarkers = [...extractFactMarkers(claim)];
    const reasons = cautiousInsufficientClaim
      ? []
      : bestEvaluation?.reasons || ['no_retrieved_sources'];
    return {
      claim_index: index + 1,
      text: claim,
      citation_labels: citationLabels,
      citations: citedEvaluations,
      supported,
      cited: citationLabels.length > 0,
      deterministic_checks: {
        fact_markers: factMarkers,
        marker_match: cautiousInsufficientClaim || Boolean(bestEvaluation && bestEvaluation.marker_coverage >= 1),
        polarity_match: cautiousInsufficientClaim || !bestEvaluation?.polarity_conflict,
      },
      reasons,
    } satisfies AtomicClaimEvaluation;
  });

  const citationDecisions = claims.flatMap((claim) => claim.citations);
  const supportedCitations = citationDecisions.filter((citation) => citation.supported).length;
  const supportedCitedClaims = claims.filter((claim) => (
    claim.cited && claim.citations.some((citation) => citation.supported)
  )).length;
  const citationPrecision = citationDecisions.length
    ? clampScore(supportedCitations / citationDecisions.length)
    : 0;
  const citationCoverage = claims.length
    ? clampScore(supportedCitedClaims / claims.length)
    : 0;
  const citationF1 = citationPrecision + citationCoverage > 0
    ? clampScore((2 * citationPrecision * citationCoverage) / (citationPrecision + citationCoverage))
    : 0;
  const hallucinationRate = claims.length
    ? clampScore(claims.filter((claim) => !claim.supported).length / claims.length)
    : 0;
  const claimMetricsApplicable = sources.length > 0 && claims.length > 0;
  const precisionApplicable = claimMetricsApplicable && citationDecisions.length > 0;

  return {
    verifier_version: ANSWER_CLAIM_VERIFIER_VERSION,
    claims,
    citation_precision: citationPrecision,
    citation_coverage: citationCoverage,
    citation_f1: citationF1,
    hallucination_rate: hallucinationRate,
    abstained: hasCautiousInsufficientAnswer(answer),
    retrieval_insufficient_evidence: insufficientEvidence,
    metric_applicability: {
      claim_verification: claimMetricsApplicable,
      citation_precision: precisionApplicable,
      citation_coverage: claimMetricsApplicable,
      citation_f1: precisionApplicable,
      hallucination_rate: claimMetricsApplicable,
    },
  };
};

export const verifyAnswerGrounding = (
  answer: string,
  sources: ChatSource[],
  quality?: Partial<RagQualitySummary>,
  insufficientEvidence = false,
  verificationSources: ChatSource[] = sources
): AnswerGroundingVerification => {
  if (!sources.length) {
    const normalizedAnswer = answer.trim();
    const correctAbstention = Boolean(
      normalizedAnswer
      && insufficientEvidence
      && hasCautiousInsufficientAnswer(normalizedAnswer)
    );
    return {
      status: correctAbstention ? 'not_applicable' : 'unsupported',
      score: 0,
      supported_source_count: 0,
      verified_sources: [],
      reasons: correctAbstention
        ? ['no_sources', 'correct_abstention']
        : ['no_sources', normalizedAnswer ? 'answer_without_evidence' : 'empty_answer'],
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

  const completeByIdentity = new Map(verificationSources.map((source) => [sourceIdentity(source), source]));
  const completeSources = sources.map((source) => completeByIdentity.get(sourceIdentity(source)) || source);
  const claims = citedClaims(normalizedAnswer);
  const modelCitedLabels = [...new Set(claims.map((item) => item.sourceNumber))];
  if (claims.length > 0) {
    const decisions: CitationDecision[] = claims.map(({ sourceNumber, claim }) => {
      const source = completeSources[sourceNumber - 1];
      if (!source) {
        return { source_number: sourceNumber, supported: false, score: 0, reasons: ['invalid_citation_label'] };
      }
      if (!claim) {
        return { source_number: sourceNumber, supported: false, score: 0, reasons: ['citation_without_local_claim'] };
      }
      const claimTerms = extractGroundingTerms(claim);
      const sourceEvidence = `${source.filename}\n${source.content}`;
      const sourceTerms = extractGroundingTerms(sourceEvidence);
      const termScore = overlapRatio(claimTerms, sourceTerms);
      const claimMarkers = extractFactMarkers(claim);
      const sourceMarkers = extractFactMarkers(sourceEvidence);
      const markerCoverage = claimMarkers.size ? overlapRatio(claimMarkers, sourceMarkers) : 1;
      const polarityConflict = citationPolarityConflict(claim, sourceEvidence);
      const reasons: string[] = [];
      const minimumTermScore = claimMarkers.size > 0 ? 0.08 : 0.12;
      if (termScore < minimumTermScore) reasons.push('citation_claim_not_supported');
      if (markerCoverage < 1) reasons.push('missing_claim_markers_in_source');
      if (polarityConflict) reasons.push('citation_polarity_conflict');
      const score = clampScore(termScore * 0.75 + markerCoverage * 0.25);
      return {
        source_number: sourceNumber,
        supported: reasons.length === 0,
        score,
        reasons,
        support_mode: 'lexical',
      };
    });
    const supportedLabels = new Set(decisions.filter((item) => item.supported).map((item) => item.source_number));
    const autoAttributedLabels = new Set<number>();
    const autoAttributionDecisions: CitationDecision[] = [];
    for (const claim of uncitedSubstantiveClaims(normalizedAnswer)) {
      const claimTerms = extractGroundingTerms(claim);
      const claimMarkers = extractFactMarkers(claim);
      let best: { sourceNumber: number; score: number } | null = null;
      for (let index = 0; index < completeSources.length; index += 1) {
        const source = completeSources[index];
        const sourceEvidence = `${source.filename}\n${source.content}`;
        const termScore = overlapRatio(claimTerms, extractGroundingTerms(sourceEvidence));
        const markerCoverage = claimMarkers.size
          ? overlapRatio(claimMarkers, extractFactMarkers(sourceEvidence))
          : 1;
        if (markerCoverage < 1 || citationPolarityConflict(claim, sourceEvidence)) continue;
        const directSupported = termScore >= 0.18;
        if (!directSupported) continue;
        const score = clampScore(termScore * 0.75 + markerCoverage * 0.25);
        if (!best || score > best.score) {
          best = {
            sourceNumber: index + 1,
            score,
          };
        }
      }
      if (best) {
        autoAttributedLabels.add(best.sourceNumber);
        autoAttributionDecisions.push({
          source_number: best.sourceNumber,
          supported: true,
          score: best.score,
          reasons: [],
          support_mode: 'lexical',
          auto_attributed: true,
        });
      }
    }
    const finalSupportedLabels = new Set([...supportedLabels, ...autoAttributedLabels]);
    const verifiedSources = sources.filter((_, index) => finalSupportedLabels.has(index + 1));
    const autoAttributedSources = sources.filter((_, index) => autoAttributedLabels.has(index + 1));
    const preVerificationSources = sources.filter((_, index) => modelCitedLabels.includes(index + 1));
    const supportRatio = decisions.length
      ? decisions.filter((item) => item.supported).length / decisions.length
      : 0;
    const answerTerms = extractGroundingTerms(normalizedAnswer);
    const sourceTerms = extractGroundingTerms(completeSources.map((source) => source.content).join('\n'));
    const answerCoverage = overlapRatio(answerTerms, sourceTerms);
    const score = clampScore(supportRatio * 0.75 + answerCoverage * 0.25);
    const reasons = decisions.flatMap((item) => item.reasons);
    const supportLabel = String(quality?.support_label || '').toLowerCase();
    const evidenceLabel = String(quality?.evidence_label || '').toLowerCase();
    const cautious = hasCautiousInsufficientAnswer(normalizedAnswer);
    if (supportLabel === 'unsupported' || evidenceLabel === 'weak') reasons.push('retrieval_quality_not_supported');
    if (insufficientEvidence && !cautious) reasons.push('answer_not_cautious_under_insufficient_evidence');

    let status: AnswerGroundingStatus;
    if (cautious && insufficientEvidence) status = 'partial';
    else if (
      supportRatio >= 0.8
      && verifiedSources.length > 0
      && supportLabel !== 'unsupported'
      && evidenceLabel !== 'weak'
    ) status = 'supported';
    else if (verifiedSources.length > 0 && supportLabel !== 'unsupported') status = 'partial';
    else status = 'unsupported';

    return {
      status,
      score,
      supported_source_count: verifiedSources.length,
      verified_sources: status === 'unsupported' ? [] : verifiedSources,
      reasons: [...new Set(reasons)],
      model_cited_labels: modelCitedLabels,
      pre_verification_cited_sources: preVerificationSources,
      citation_decisions: [...decisions, ...autoAttributionDecisions],
      auto_attributed_sources: autoAttributedSources,
    };
  }

  const answerTerms = extractGroundingTerms(normalizedAnswer);
  const answerMarkers = extractMarkers(normalizedAnswer);
  const sourceTerms = extractGroundingTerms(completeSources.map((source) => source.content).join('\n'));
  const sourceMarkers = extractMarkers(completeSources.map((source) => source.content).join('\n'));
  const answerCoverage = overlapRatio(answerTerms, sourceTerms);
  const markerCoverage = answerMarkers.size
    ? overlapRatio(answerMarkers, sourceMarkers)
    : 1;

  const scoredSources = completeSources.map((source, index) => {
    const terms = extractGroundingTerms(source.content);
    const markers = extractMarkers(source.content);
    const termScore = overlapRatio(answerTerms, terms);
    const markerScore = answerMarkers.size ? overlapRatio(answerMarkers, markers) : 0;
    const score = clampScore(termScore * 0.75 + markerScore * 0.25);
    return { source: sources[index], score, markerScore };
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

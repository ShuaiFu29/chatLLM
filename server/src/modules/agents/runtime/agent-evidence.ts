import {
  verifyAnswerGrounding,
  type AnswerGroundingVerification,
  type ChatSource,
  type RagQualitySummary,
} from '../../../lib/chatSources';
import { serverEnv } from '../../../lib/env';

export class AgentResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentResourceLimitError';
  }
}

export interface AgentTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type SubagentEvidenceStatus =
  | 'supported'
  | 'partial'
  | 'insufficient_evidence'
  | 'not_applicable';

/**
 * Durable result of one successful delegated Run.
 *
 * This is written to the child's final assistant step. The answer remains in
 * `content` for backwards compatibility and cheap timeline reads; everything
 * needed to reconstruct the evidence path lives here so another process can
 * reconcile the dispatch without relying on in-memory state.
 */
export interface SubagentResultEnvelope {
  version: 1;
  answer: string;
  status: SubagentEvidenceStatus;
  evidence_used: boolean;
  sources: ChatSource[];
  grounding?: Record<string, unknown>;
  rag_quality?: Partial<RagQualitySummary>;
  insufficient_evidence: boolean;
  usage: AgentTokenUsage;
  warnings: string[];
}

export interface SubagentDispatchEvidence {
  envelopes: SubagentResultEnvelope[];
  usage: AgentTokenUsage;
  warnings: string[];
}

const SUBAGENT_DISPATCH_EVIDENCE = Symbol.for('chatllm.subagentDispatchEvidence');
const DURABLE_EVIDENCE_PAYLOAD_VERSION = 1;
const SOURCE_TOOL_KEYS = new Set([
  'agentic_rag',
  'list_documents',
  'query_knowledge_graph',
  'read_document_excerpt',
]);
const MAX_EVIDENCE_WARNINGS = 32;
const MAX_WARNING_CHARS = 500;

export const getAgentCheckpointEvidenceSourceByteLimit = () => Math.max(
  1,
  Math.min(
    serverEnv.AGENT_MAX_SOURCE_BYTES,
    Math.floor(serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES * 0.25),
  ),
);

const emptyUsage = (): AgentTokenUsage => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});

const safeTokenCount = (value: unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
};

export const normalizeAgentTokenUsage = (usage?: Partial<AgentTokenUsage> | null) => {
  const promptTokens = safeTokenCount(usage?.prompt_tokens);
  const completionTokens = safeTokenCount(usage?.completion_tokens);
  const reportedTotal = safeTokenCount(usage?.total_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: reportedTotal || promptTokens + completionTokens,
  };
};

export const addAgentTokenUsage = (
  total: AgentTokenUsage,
  usage?: Partial<AgentTokenUsage> | null,
) => {
  const normalized = normalizeAgentTokenUsage(usage);
  total.prompt_tokens += normalized.prompt_tokens;
  total.completion_tokens += normalized.completion_tokens;
  total.total_tokens += normalized.total_tokens;
  return total;
};

const qualityLabelOrder: Record<string, number> = {
  unsupported: 0,
  weak: 0,
  partial: 1,
  supported: 2,
  strong: 2,
};

const worstQualityLabel = (left: unknown, right: unknown) => {
  const leftValue = typeof left === 'string' ? left : '';
  const rightValue = typeof right === 'string' ? right : '';
  return (qualityLabelOrder[leftValue.toLowerCase()] ?? 0)
    <= (qualityLabelOrder[rightValue.toLowerCase()] ?? 0)
    ? leftValue || rightValue
    : rightValue || leftValue;
};

/** Merge RAG quality across direct retrieval and any delegated subtree. */
export const mergeAgenticRagQuality = (
  previous: Partial<RagQualitySummary> | undefined,
  next: Partial<RagQualitySummary> | undefined,
) => {
  if (!previous) return next;
  if (!next) return previous;
  const merged: Partial<RagQualitySummary> = { ...previous, ...next };
  for (const key of [
    'retrieval_score',
    'citation_score',
    'evidence_score',
    'overall_score',
    'verification_score',
  ]) {
    const left = previous[key as keyof RagQualitySummary];
    const right = next[key as keyof RagQualitySummary];
    if (typeof left === 'number' && typeof right === 'number') {
      (merged as Record<string, unknown>)[key] = Math.min(left, right);
    }
  }
  if (previous.evidence_label || next.evidence_label) {
    merged.evidence_label = worstQualityLabel(previous.evidence_label, next.evidence_label);
  }
  if (previous.support_label || next.support_label) {
    merged.support_label = worstQualityLabel(previous.support_label, next.support_label);
  }
  if (previous.risk_level || next.risk_level) {
    const riskOrder: Record<string, number> = { low: 0, medium: 1, high: 2 };
    const left = String(previous.risk_level || '').toLowerCase();
    const right = String(next.risk_level || '').toLowerCase();
    merged.risk_level = (riskOrder[left] ?? 0) >= (riskOrder[right] ?? 0) ? left : right;
  }
  merged.risk_factors = [...new Set([
    ...(previous.risk_factors || []),
    ...(next.risk_factors || []),
  ])];
  merged.missing_markers = [...new Set([
    ...(previous.missing_markers || []),
    ...(next.missing_markers || []),
  ])];
  merged.matched_markers = [...new Set([
    ...(previous.matched_markers || []),
    ...(next.matched_markers || []),
  ])];
  return merged;
};

const sourceIdentity = (source: ChatSource) => (
  `${source.file_id || source.filename}:${source.chunk_id || source.chunk_index}`
);

const assertSourceLimits = (
  sources: ChatSource[],
  limits: { maxSources: number; maxSourceBytes: number },
) => {
  if (sources.length > limits.maxSources) {
    throw new AgentResourceLimitError('Agent source limit exceeded');
  }
  if (Buffer.byteLength(JSON.stringify(sources), 'utf8') > limits.maxSourceBytes) {
    throw new AgentResourceLimitError('Agent source size limit exceeded');
  }
};

const mergeSources = (
  target: ChatSource[],
  additions: ChatSource[],
  limits: { maxSources: number; maxSourceBytes: number },
) => {
  const known = new Set(target.map(sourceIdentity));
  const unique = additions.filter((source) => {
    const identity = sourceIdentity(source);
    if (known.has(identity)) return false;
    known.add(identity);
    return true;
  });
  const next = [...target, ...unique];
  assertSourceLimits(next, limits);
  target.push(...unique);
  return unique.length;
};

/** Extract canonical ChatSource records from one workspace/RAG tool result. */
export const collectAgentSources = (
  toolKey: string,
  result: unknown,
  sources: ChatSource[],
  limits = {
    maxSources: serverEnv.AGENT_MAX_SOURCES,
    maxSourceBytes: serverEnv.AGENT_MAX_SOURCE_BYTES,
  },
) => {
  if (!SOURCE_TOOL_KEYS.has(toolKey)) return 0;
  const resultRecord = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : {};
  const candidates = Array.isArray(result)
    ? result
    : Array.isArray(resultRecord.results) ? resultRecord.results : [];
  const additions: ChatSource[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const value = candidate as Record<string, unknown>;
    const metadata = value.metadata && typeof value.metadata === 'object'
      ? value.metadata as Record<string, unknown>
      : {};
    const filename = String(value.filename || metadata.filename || '').trim();
    const content = String(value.content || (
      toolKey === 'list_documents' && filename
        ? [
            `Document: ${filename}`,
            value.status ? `Status: ${String(value.status)}` : '',
            value.document_kind ? `Kind: ${String(value.document_kind)}` : '',
            value.size !== undefined ? `Size: ${String(value.size)} bytes` : '',
          ].filter(Boolean).join('\n')
        : ''
    )).trim();
    if (!filename || !content) continue;
    const fileId = String(
      value.file_id || (toolKey === 'list_documents' ? value.id : '') || metadata.file_id || '',
    ).trim() || undefined;
    const chunkId = String(value.chunk_id || value.id || '').trim() || undefined;
    const chunkIndex = Number(value.chunk_index ?? metadata.chunk_index);
    const sourceUnitIds = value.source_unit_ids ?? metadata.source_unit_ids;
    const sourceLocator = value.source_locator ?? metadata.source_locator;
    const documentKind = value.document_kind ?? metadata.document_kind;
    const conversionGenerationId = value.conversion_generation_id
      ?? metadata.conversion_generation_id;
    additions.push({
      file_id: fileId,
      chunk_id: chunkId,
      filename,
      chunk_index: Number.isInteger(chunkIndex) ? chunkIndex : undefined,
      similarity: toolKey === 'list_documents' ? 1 : Number(value.similarity || 0),
      content: content.slice(0, 5000),
      document_kind: typeof documentKind === 'string'
        ? documentKind as ChatSource['document_kind']
        : undefined,
      conversion_generation_id: typeof conversionGenerationId === 'string'
        ? conversionGenerationId
        : undefined,
      source_unit_ids: Array.isArray(sourceUnitIds)
        ? sourceUnitIds.filter((item): item is string => typeof item === 'string')
        : undefined,
      source_locator: sourceLocator && typeof sourceLocator === 'object'
        ? sourceLocator as ChatSource['source_locator']
        : undefined,
      source_role: typeof value.source_role === 'string' ? value.source_role : undefined,
    });
  }
  return mergeSources(sources, additions, limits);
};

const normalizeWarnings = (warnings: unknown) => {
  if (!Array.isArray(warnings)) return [];
  return [...new Set(warnings
    .filter((warning): warning is string => typeof warning === 'string')
    .map((warning) => warning.trim().slice(0, MAX_WARNING_CHARS))
    .filter(Boolean))].slice(0, MAX_EVIDENCE_WARNINGS);
};

const isEvidenceSource = (value: unknown): value is ChatSource => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Partial<ChatSource>;
  return typeof source.filename === 'string'
    && source.filename.trim().length > 0
    && typeof source.content === 'string'
    && Number.isFinite(Number(source.similarity));
};

/**
 * Validate a checkpoint/database value before it is allowed back into the
 * evidence collector. Durable state is not trusted merely because it came from
 * our database: old versions, manual repairs and partial writes can all leave a
 * shape the current runtime must reject.
 */
export const normalizeAgentEvidenceSnapshot = (
  value: unknown,
  limits = {
    maxSources: serverEnv.AGENT_MAX_SOURCES,
    maxSourceBytes: serverEnv.AGENT_MAX_SOURCE_BYTES,
  },
): AgentEvidenceSnapshot => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentResourceLimitError('Agent evidence snapshot must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.evidenceUsed !== 'boolean'
    || typeof record.insufficientEvidence !== 'boolean'
    || !Array.isArray(record.sources)
    || !record.sources.every(isEvidenceSource)
  ) {
    throw new AgentResourceLimitError('Agent evidence snapshot is invalid');
  }
  if (
    record.ragQuality !== undefined
    && (!record.ragQuality || typeof record.ragQuality !== 'object'
      || Array.isArray(record.ragQuality))
  ) {
    throw new AgentResourceLimitError('Agent evidence quality snapshot is invalid');
  }
  const sources = structuredClone(record.sources as ChatSource[]);
  assertSourceLimits(sources, limits);
  return {
    evidenceUsed: record.evidenceUsed,
    insufficientEvidence: record.insufficientEvidence,
    sources,
    ...(record.ragQuality
      ? { ragQuality: structuredClone(record.ragQuality as Partial<RagQualitySummary>) }
      : {}),
    warnings: normalizeWarnings(record.warnings),
  };
};

export const summarizeAgentGrounding = (grounding: AnswerGroundingVerification) => {
  const summary: Record<string, unknown> = { ...grounding };
  delete summary.verified_sources;
  delete summary.pre_verification_cited_sources;
  delete summary.auto_attributed_sources;
  return summary;
};

export const extractJsonGroundingText = (content: string) => {
  try {
    const value = JSON.parse(content) as unknown;
    const strings: string[] = [];
    const visit = (node: unknown, key = '') => {
      // Provenance fields describe where a claim came from; treating them as
      // answer text can make an unsupported JSON answer look grounded merely
      // because it repeated a filename or chunk id.
      if (/(?:^|_)(?:citation|citations|source|sources|filename|file_id|chunk_id|metadata)(?:$|_)/i.test(key)) return;
      if (typeof node === 'string') {
        const text = node.trim();
        if (text) strings.push(text);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item) => visit(item, key));
        return;
      }
      if (node && typeof node === 'object') {
        Object.entries(node).forEach(([childKey, childValue]) => visit(childValue, childKey));
      }
    };
    visit(value);
    return strings.join('\n');
  } catch {
    return content;
  }
};

export const createSubagentResultEnvelope = (input: {
  answer: string;
  status: SubagentEvidenceStatus;
  evidenceUsed: boolean;
  sources: ChatSource[];
  grounding?: Record<string, unknown>;
  ragQuality?: Partial<RagQualitySummary>;
  insufficientEvidence?: boolean;
  usage?: Partial<AgentTokenUsage>;
  warnings?: string[];
}): SubagentResultEnvelope => ({
  version: 1,
  answer: input.answer,
  status: input.status,
  evidence_used: input.evidenceUsed,
  sources: input.sources,
  ...(input.grounding ? { grounding: input.grounding } : {}),
  ...(input.ragQuality ? { rag_quality: input.ragQuality } : {}),
  insufficient_evidence: input.insufficientEvidence === true,
  usage: normalizeAgentTokenUsage(input.usage),
  warnings: normalizeWarnings(input.warnings),
});

export const parseSubagentResultEnvelope = (value: unknown): SubagentResultEnvelope | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.answer !== 'string') return undefined;
  if (!['supported', 'partial', 'insufficient_evidence', 'not_applicable'].includes(
    String(record.status),
  )) return undefined;
  if (!Array.isArray(record.sources)) return undefined;
  const sources = record.sources.filter((source): source is ChatSource => Boolean(
    source
    && typeof source === 'object'
    && typeof (source as ChatSource).filename === 'string'
    && typeof (source as ChatSource).content === 'string'
    && Number.isFinite(Number((source as ChatSource).similarity)),
  ));
  if (sources.length !== record.sources.length) return undefined;
  try {
    assertSourceLimits(sources, {
      maxSources: serverEnv.AGENT_MAX_SOURCES,
      maxSourceBytes: serverEnv.AGENT_MAX_SOURCE_BYTES,
    });
  } catch {
    return undefined;
  }
  return createSubagentResultEnvelope({
    answer: record.answer,
    status: record.status as SubagentEvidenceStatus,
    evidenceUsed: record.evidence_used === true,
    sources,
    grounding: record.grounding && typeof record.grounding === 'object'
      ? record.grounding as Record<string, unknown>
      : undefined,
    ragQuality: record.rag_quality && typeof record.rag_quality === 'object'
      ? record.rag_quality as Partial<RagQualitySummary>
      : undefined,
    insufficientEvidence: record.insufficient_evidence === true,
    usage: record.usage && typeof record.usage === 'object'
      ? record.usage as Partial<AgentTokenUsage>
      : undefined,
    warnings: normalizeWarnings(record.warnings),
  });
};

export const attachSubagentDispatchEvidence = <T extends object>(
  target: T,
  evidence: SubagentDispatchEvidence,
) => {
  Object.defineProperty(target, SUBAGENT_DISPATCH_EVIDENCE, {
    value: evidence,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return target;
};

const compactEvidenceSource = (source: ChatSource, content: string): ChatSource => ({
  ...(source.file_id ? { file_id: source.file_id } : {}),
  ...(source.chunk_id ? { chunk_id: source.chunk_id } : {}),
  filename: source.filename,
  ...(source.chunk_index !== undefined ? { chunk_index: source.chunk_index } : {}),
  similarity: source.similarity,
  content,
  ...(source.document_kind ? { document_kind: source.document_kind } : {}),
  ...(source.conversion_generation_id
    ? { conversion_generation_id: source.conversion_generation_id }
    : {}),
  ...(source.source_role ? { source_role: source.source_role } : {}),
});

const boundEvidenceSnapshotForCheckpoint = (snapshot: AgentEvidenceSnapshot) => {
  const maxBytes = getAgentCheckpointEvidenceSourceByteLimit();
  const sources: ChatSource[] = [];
  let truncated = false;
  const base = {
    ...snapshot,
    sources,
  };
  for (const source of snapshot.sources) {
    if (sources.length >= serverEnv.AGENT_MAX_SOURCES) {
      truncated = true;
      break;
    }
    const fits = (candidate: ChatSource) => Buffer.byteLength(JSON.stringify({
      ...base,
      sources: [...sources, candidate],
    }), 'utf8') <= maxBytes;
    if (fits(source)) {
      sources.push(source);
      continue;
    }
    let low = 1;
    let high = source.content.length;
    let best: ChatSource | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = compactEvidenceSource(source, source.content.slice(0, middle));
      if (fits(candidate)) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best) sources.push(best);
    truncated = true;
    break;
  }
  const warnings = truncated
    ? normalizeWarnings([...snapshot.warnings, 'Evidence was truncated for durable recovery'])
    : snapshot.warnings;
  const bounded = { ...base, sources, warnings };
  return normalizeAgentEvidenceSnapshot(bounded, {
    maxSources: serverEnv.AGENT_MAX_SOURCES,
    maxSourceBytes: maxBytes,
  });
};

const normalizeSubagentDispatchEvidence = (
  value: unknown,
): SubagentDispatchEvidence | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.envelopes)) return undefined;
  const envelopes = record.envelopes.map(parseSubagentResultEnvelope);
  if (envelopes.some((envelope) => !envelope)) return undefined;
  return {
    envelopes: envelopes as SubagentResultEnvelope[],
    usage: normalizeAgentTokenUsage(
      record.usage && typeof record.usage === 'object'
        ? record.usage as Partial<AgentTokenUsage>
        : undefined,
    ),
    warnings: normalizeWarnings(record.warnings),
  };
};

const boundSubagentDispatchEvidence = (value: SubagentDispatchEvidence) => {
  const maxBytes = Math.floor(serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES * 0.65);
  const envelopes = value.envelopes.map((envelope) => ({ ...envelope, sources: [] as ChatSource[] }));
  let truncated = false;
  const fits = () => Buffer.byteLength(JSON.stringify({
    envelopes,
    usage: value.usage,
    warnings: value.warnings,
  }), 'utf8') <= maxBytes;
  if (!fits()) {
    // Answers are already present in modelContent. Keep a bounded identity here
    // so envelopes remain valid while reserving the durable channel for sources.
    for (const envelope of envelopes) envelope.answer = envelope.answer.slice(0, 1_000);
    truncated = true;
  }
  for (let envelopeIndex = 0; envelopeIndex < value.envelopes.length; envelopeIndex += 1) {
    const sourceEnvelope = value.envelopes[envelopeIndex];
    const targetEnvelope = envelopes[envelopeIndex];
    for (const source of sourceEnvelope.sources) {
      targetEnvelope.sources.push(source);
      if (fits()) continue;
      targetEnvelope.sources.pop();
      let low = 1;
      let high = source.content.length;
      let best: ChatSource | null = null;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = compactEvidenceSource(source, source.content.slice(0, middle));
        targetEnvelope.sources.push(candidate);
        const candidateFits = fits();
        targetEnvelope.sources.pop();
        if (candidateFits) {
          best = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (best) targetEnvelope.sources.push(best);
      truncated = true;
      break;
    }
    if (truncated && !fits()) break;
  }
  return {
    envelopes,
    usage: normalizeAgentTokenUsage(value.usage),
    warnings: normalizeWarnings(truncated
      ? [...value.warnings, 'Delegated evidence was truncated for durable recovery']
      : value.warnings),
  };
};

/**
 * Convert non-enumerable in-process evidence into a versioned JSON payload.
 * Ordinary tools keep their exact value; delegated work additionally persists
 * full child envelopes that are intentionally omitted from model-visible JSON.
 */
export const createAgentDurableEvidencePayload = (
  toolKey: string,
  value: unknown,
  dispatchSource: unknown = value,
) => {
  if (toolKey === 'dispatch_subagents') {
    const dispatch = readSubagentDispatchEvidence(dispatchSource);
    return {
      version: DURABLE_EVIDENCE_PAYLOAD_VERSION,
      value: value ?? null,
      ...(dispatch ? { subagentDispatch: boundSubagentDispatchEvidence(dispatch) } : {}),
    };
  }
  if (SOURCE_TOOL_KEYS.has(toolKey)) {
    const delta = new AgentEvidenceCollector();
    const collected = delta.collect(toolKey, dispatchSource);
    return {
      version: DURABLE_EVIDENCE_PAYLOAD_VERSION,
      value: value ?? null,
      evidenceSnapshot: boundEvidenceSnapshotForCheckpoint(delta.snapshot()),
      delegatedUsage: collected.delegatedUsage,
    };
  }
  return value;
};

const unwrapAgentDurableEvidencePayload = (toolKey: string, value: unknown) => {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return { value };
  const record = value as Record<string, unknown>;
  if (
    record.version !== DURABLE_EVIDENCE_PAYLOAD_VERSION
    || !('value' in record)
    || (toolKey !== 'dispatch_subagents' && !SOURCE_TOOL_KEYS.has(toolKey))
  ) {
    return { value };
  }
  return {
    value: record.value,
    dispatch: normalizeSubagentDispatchEvidence(record.subagentDispatch),
    snapshot: record.evidenceSnapshot,
    delegatedUsage: normalizeAgentTokenUsage(
      record.delegatedUsage && typeof record.delegatedUsage === 'object'
        ? record.delegatedUsage as Partial<AgentTokenUsage>
        : undefined,
    ),
  };
};

export const readSubagentDispatchEvidence = (
  value: unknown,
): SubagentDispatchEvidence | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const evidence = (value as Record<symbol, unknown>)[SUBAGENT_DISPATCH_EVIDENCE];
  return normalizeSubagentDispatchEvidence(evidence);
};

export class AgentEvidenceCollector {
  readonly sources: ChatSource[] = [];
  private readonly limits: { maxSources: number; maxSourceBytes: number };
  private _evidenceUsed = false;
  private _insufficientEvidence = false;
  private _ragQuality: Partial<RagQualitySummary> | undefined;
  private readonly warningSet = new Set<string>();

  constructor(limits?: { maxSources?: number; maxSourceBytes?: number }) {
    this.limits = {
      maxSources: limits?.maxSources ?? serverEnv.AGENT_MAX_SOURCES,
      maxSourceBytes: limits?.maxSourceBytes ?? serverEnv.AGENT_MAX_SOURCE_BYTES,
    };
  }

  get evidenceUsed() { return this._evidenceUsed; }

  get insufficientEvidence() { return this._insufficientEvidence; }

  get ragQuality() { return this._ragQuality; }

  get warnings() { return [...this.warningSet]; }

  snapshot(): AgentEvidenceSnapshot {
    return {
      evidenceUsed: this._evidenceUsed,
      insufficientEvidence: this._insufficientEvidence,
      sources: structuredClone(this.sources),
      ...(this._ragQuality ? { ragQuality: structuredClone(this._ragQuality) } : {}),
      warnings: this.warnings,
    };
  }

  /** Atomically restore a previously validated durable evidence snapshot. */
  restore(snapshot: unknown) {
    const restored = normalizeAgentEvidenceSnapshot(snapshot, this.limits);
    this.sources.splice(0, this.sources.length, ...restored.sources);
    this._evidenceUsed = restored.evidenceUsed;
    this._insufficientEvidence = restored.insufficientEvidence;
    this._ragQuality = restored.ragQuality;
    this.warningSet.clear();
    this.addWarnings(restored.warnings);
    return this;
  }

  /** Merge one bounded durable tool delta without trusting its database shape. */
  merge(snapshot: unknown) {
    const restored = normalizeAgentEvidenceSnapshot(snapshot, this.limits);
    mergeSources(this.sources, restored.sources, this.limits);
    this._evidenceUsed = this._evidenceUsed || restored.evidenceUsed;
    this._insufficientEvidence = this._insufficientEvidence || restored.insufficientEvidence;
    this._ragQuality = mergeAgenticRagQuality(this._ragQuality, restored.ragQuality);
    this.addWarnings(restored.warnings);
    return this;
  }

  private addWarnings(warnings: unknown) {
    for (const warning of normalizeWarnings(warnings)) {
      if (this.warningSet.size >= MAX_EVIDENCE_WARNINGS) break;
      this.warningSet.add(warning);
    }
  }

  collect(toolKey: string, result: unknown) {
    const delegatedUsage = emptyUsage();
    const durable = unwrapAgentDurableEvidencePayload(toolKey, result);
    const evidenceValue = durable.value;
    if (durable.snapshot !== undefined) {
      this.merge(durable.snapshot);
      addAgentTokenUsage(delegatedUsage, durable.delegatedUsage);
      return { delegatedUsage };
    }
    if (SOURCE_TOOL_KEYS.has(toolKey)) {
      const added = collectAgentSources(toolKey, evidenceValue, this.sources, this.limits);
      if (added > 0 || toolKey === 'agentic_rag') this._evidenceUsed = true;
      const record = evidenceValue && typeof evidenceValue === 'object'
        ? evidenceValue as Record<string, unknown>
        : {};
      this.addWarnings(record.warnings);
      if (toolKey === 'agentic_rag') {
        this._insufficientEvidence = this._insufficientEvidence
          || record.insufficient_evidence === true;
        if (record.quality && typeof record.quality === 'object') {
          this._ragQuality = mergeAgenticRagQuality(
            this._ragQuality,
            record.quality as Partial<RagQualitySummary>,
          );
        }
      }
    }

    if (toolKey === 'dispatch_subagents') {
      const dispatch = durable.dispatch || readSubagentDispatchEvidence(evidenceValue);
      if (dispatch) {
        addAgentTokenUsage(delegatedUsage, dispatch.usage);
        this.addWarnings(dispatch.warnings);
        for (const envelope of dispatch.envelopes) {
          mergeSources(this.sources, envelope.sources, this.limits);
          this._evidenceUsed = this._evidenceUsed || envelope.evidence_used;
          this._insufficientEvidence = this._insufficientEvidence
            || envelope.insufficient_evidence
            || envelope.status === 'insufficient_evidence';
          this._ragQuality = mergeAgenticRagQuality(this._ragQuality, envelope.rag_quality);
          this.addWarnings(envelope.warnings);
        }
      }
    }
    return { delegatedUsage };
  }

  verify(answer: string) {
    return verifyAnswerGrounding(
      answer,
      this.sources,
      this._ragQuality,
      this._insufficientEvidence,
      this.sources,
    );
  }
}

export interface AgentEvidenceSnapshot {
  evidenceUsed: boolean;
  insufficientEvidence: boolean;
  sources: ChatSource[];
  ragQuality?: Partial<RagQualitySummary>;
  warnings: string[];
}

/**
 * Leave enough room in a child assistant step for its answer, grounding summary,
 * usage and warning metadata. The repository still performs the exact final
 * byte check before the transaction starts.
 */
export const getSubagentEvidenceSourceByteLimit = () => Math.max(
  1,
  Math.min(
    serverEnv.AGENT_MAX_SOURCE_BYTES,
    getAgentCheckpointEvidenceSourceByteLimit(),
  ),
);

export interface RagDocument {
  id?: string;
  content?: string;
  metadata?: {
    filename?: string;
    file_id?: string;
    chunk_index?: number;
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
}

const MAX_SOURCE_SNIPPET_LENGTH = 500;

const normalizeSnippet = (content = '') => {
  const normalized = content.trim().replace(/\s+/g, ' ');
  if (normalized.length <= MAX_SOURCE_SNIPPET_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SOURCE_SNIPPET_LENGTH)}...`;
};

export const buildChatSources = (documents: RagDocument[]): ChatSource[] => {
  return documents.map((doc) => ({
    chunk_id: doc.id,
    file_id: doc.metadata?.file_id,
    filename: doc.metadata?.filename || 'Unknown source',
    chunk_index: doc.metadata?.chunk_index,
    similarity: typeof doc.similarity === 'number' ? doc.similarity : 0,
    content: normalizeSnippet(doc.content),
  }));
};

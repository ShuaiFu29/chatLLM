export interface RagDocument {
  id?: string;
  content?: string;
  metadata?: {
    filename?: string;
    file_id?: string;
    chunk_index?: number;
  };
  similarity?: number;
}

export interface ChatSource {
  chunk_id?: string;
  file_id?: string;
  filename: string;
  chunk_index?: number;
  similarity: number;
  content: string;
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

export type BuiltinAgentToolRisk = 'read' | 'write' | 'high';

export interface BuiltinAgentToolDefinition {
  key: string;
  name: string;
  description: string;
  category: 'knowledge' | 'workspace' | 'conversation' | 'utility';
  risk_level: BuiltinAgentToolRisk;
  requires_project: boolean;
}

export const builtinAgentTools: BuiltinAgentToolDefinition[] = [
  {
    key: 'agentic_rag',
    name: 'Agentic RAG',
    description: 'Search workspace knowledge with query planning, hybrid retrieval, graph evidence, reranking, and grounding metadata.',
    category: 'knowledge',
    risk_level: 'read',
    requires_project: true,
  },
  {
    key: 'list_documents',
    name: 'List documents',
    description: 'List documents that belong to the active workspace.',
    category: 'knowledge',
    risk_level: 'read',
    requires_project: true,
  },
  {
    key: 'read_document_excerpt',
    name: 'Read document excerpt',
    description: 'Read bounded excerpts from a workspace document that the current user can access.',
    category: 'knowledge',
    risk_level: 'read',
    requires_project: true,
  },
  {
    key: 'query_knowledge_graph',
    name: 'Query knowledge graph',
    description: 'Search workspace entities and relationships with their source documents.',
    category: 'knowledge',
    risk_level: 'read',
    requires_project: true,
  },
  {
    key: 'search_conversation_history',
    name: 'Search conversation history',
    description: 'Search the current user\'s prior conversations within the permitted workspace scope.',
    category: 'conversation',
    risk_level: 'read',
    requires_project: false,
  },
  {
    key: 'get_project_context',
    name: 'Get project context',
    description: 'Read the active workspace name, description, and high-level resource counts.',
    category: 'workspace',
    risk_level: 'read',
    requires_project: true,
  },
  {
    key: 'calculator',
    name: 'Calculator',
    description: 'Evaluate bounded arithmetic expressions without executing code.',
    category: 'utility',
    risk_level: 'read',
    requires_project: false,
  },
  {
    key: 'current_time',
    name: 'Current time',
    description: 'Return the current date and time for an IANA timezone.',
    category: 'utility',
    risk_level: 'read',
    requires_project: false,
  },
];

export const builtinAgentToolKeys = new Set(builtinAgentTools.map((tool) => tool.key));

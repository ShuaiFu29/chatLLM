import type { SourceLocator } from '../lib/sourceLocator';
import type { AgentApproval, AgentEvent, AgentGroundingSummary, AgentStep } from '../features/agents/types';

export interface Conversation {
  id: string;
  project_space_id?: string | null;
  parent_conversation_id?: string | null;
  branched_from_message_id?: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  model?: string;
  temperature?: number;
  system_prompt?: string;
  enable_rag?: boolean;
  is_pinned?: boolean;
  archived_at?: string | null;
  branch_name?: string;
  is_favorite?: boolean;
  tags?: string[];
  note?: string;
  agent_id?: string | null;
}

export interface Message {
  id: string;
  conversation_id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  rag_run_id?: string | null;
  ragRunId?: string | null;
  rag_trace?: RagTraceSummary | null;
  traceSummary?: RagTraceSummary | null;
  qualitySummary?: RagQualitySummary | null;
  ragWarning?: boolean;
  ragError?: {
    code: string;
    retryable: boolean;
  };
  ragSkipped?: boolean;
  agent_run_id?: string | null;
  agentRunId?: string | null;
  agentEvents?: AgentEvent[];
  agent_run_status?: 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled' | null;
  agent_grounding?: AgentGroundingSummary | null;
  agent_steps?: AgentStep[];
  agent_approvals?: AgentApproval[];
  sources?: ChatSource[];
}

export interface ChatSource {
  chunk_id?: string;
  file_id?: string;
  filename: string;
  chunk_index?: number;
  similarity: number;
  content: string;
  document_kind?: string;
  conversion_generation_id?: string;
  source_unit_ids?: string[];
  source_locator?: SourceLocator;
}

export interface RagTraceStep {
  step_type: string;
  status: string;
  duration_ms: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface RagQualitySummary {
  retrieval_score: number;
  citation_score: number;
  evidence_score: number;
  overall_score: number;
  evidence_label: string;
  support_label?: string;
  verification_score?: number;
  risk_level?: string;
  risk_factors?: string[];
  missing_markers?: string[];
  matched_markers?: string[];
  answer_grounding_status?: string;
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
  answer_grounding?: Record<string, unknown>;
  cache?: {
    status: string;
    hit_type?: string;
    scope_fingerprint?: string;
    reused_count?: number;
  };
}

export interface ConversationComparison {
  conversations: Conversation[];
  messagesByConversation: Record<string, Message[]>;
}

export interface MessagePageInfo {
  hasMore: boolean;
  nextCursor: string | null;
  limit: number;
}

export interface ChatState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Message[];
  messagesCache: Record<string, Message[]>;
  messagePagination: Record<string, MessagePageInfo>;
  loadingConversations: boolean;
  loadingMessages: boolean;
  loadingOlderMessages: boolean;
  sendingMessage: boolean;
  isStopped: boolean;
  abortController: AbortController | null;

  fetchConversations: (options?: { includeArchived?: boolean }) => Promise<void>;
  createConversation: (title?: string, settings?: Partial<Conversation>) => Promise<string>;
  renameConversation: (id: string, title: string) => Promise<void>;
  updateConversation: (id: string, updates: Partial<Conversation>) => Promise<void>;
  toggleConversationPinned: (id: string) => Promise<void>;
  toggleConversationFavorite: (id: string) => Promise<void>;
  branchConversation: (conversationId: string, messageId?: string) => Promise<string | null>;
  compareConversations: (conversationId: string, otherConversationId: string) => Promise<ConversationComparison | null>;
  archiveConversation: (id: string) => Promise<void>;
  unarchiveConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  regenerateMessage: () => Promise<void>;
  stopGeneration: () => void;
  continueGeneration: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  refreshMessages: (id?: string) => Promise<boolean>;
  loadOlderMessages: (id?: string) => Promise<void>;
  sendMessage: (content: string, isContinue?: boolean, targetConversationId?: string) => Promise<void>;
  reset: () => void;
}

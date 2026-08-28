export type AgentVisibility = 'private' | 'project';
export type AgentStatus = 'draft' | 'published' | 'disabled';
export type AgentMemoryMode = 'none' | 'conversation' | 'user' | 'project';
export type AgentResponseFormat = 'markdown' | 'json';
export type AgentApprovalPolicy = 'never' | 'writes' | 'always';

export interface AgentToolBinding {
  key: string;
  enabled: boolean;
  configuration?: Record<string, unknown>;
}

export interface Agent {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  name: string;
  description: string;
  avatar: string;
  visibility: AgentVisibility;
  status: AgentStatus;
  current_version_id: string;
  published_version_id?: string | null;
  latest_version: number;
  version: number;
  published_version?: number | null;
  has_unpublished_changes: boolean;
  instructions: string;
  model: string;
  temperature: number;
  max_iterations: number;
  max_duration_ms: number;
  max_output_tokens: number;
  memory_mode: AgentMemoryMode;
  response_format: AgentResponseFormat;
  output_schema: Record<string, unknown>;
  approval_policy: AgentApprovalPolicy;
  tool_bindings: AgentToolBinding[];
  welcome_message: string;
  suggested_prompts: string[];
  created_at: string;
  updated_at: string;
}

export interface BuiltinAgentTool {
  key: string;
  name: string;
  description: string;
  category: 'knowledge' | 'workspace' | 'conversation' | 'utility';
  risk_level: 'read' | 'write' | 'high';
  requires_project: boolean;
}

export interface CustomAgentTool {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  name: string;
  description: string;
  kind: 'http' | 'mcp';
  risk_level: 'read' | 'write' | 'high';
  configuration: Record<string, unknown>;
  enabled: boolean;
  has_secrets: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentInput {
  name: string;
  description?: string;
  avatar?: string;
  visibility?: AgentVisibility;
  project_space_id?: string | null;
  instructions: string;
  model?: string;
  temperature?: number;
  max_iterations?: number;
  max_duration_ms?: number;
  max_output_tokens?: number;
  memory_mode?: AgentMemoryMode;
  response_format?: AgentResponseFormat;
  output_schema?: Record<string, unknown>;
  approval_policy?: AgentApprovalPolicy;
  tool_bindings?: AgentToolBinding[];
  welcome_message?: string;
  suggested_prompts?: string[];
}

export interface CustomAgentToolInput {
  name: string;
  description?: string;
  kind: 'http' | 'mcp';
  risk_level?: 'read' | 'write' | 'high';
  project_space_id?: string | null;
  configuration: Record<string, unknown>;
  secrets?: Record<string, string>;
  enabled?: boolean;
  clear_secrets?: boolean;
}

export interface ProviderHealthItem {
  id: string;
  name: string;
  models: string[];
  has_api_key: boolean;
  capabilities?: {
    tool_calling?: boolean;
  };
}

export interface ProviderHealthResponse {
  default_model: string;
  providers: ProviderHealthItem[];
}

/**
 * Step kinds the client knows how to interpret, kept open on purpose.
 *
 * The runtime records new kinds as it learns to explain more of its own
 * decisions. Pinning this to a closed union meant every server-side addition
 * broke the client build, which pushes towards either lock-step releases or
 * casting the type away. Consumers branch on the kinds they handle and ignore
 * the rest, so an unrecognised kind degrades to "not rendered" rather than to a
 * type error or a blank timeline.
 */
export type AgentStepKind =
  | 'model'
  | 'tool_call'
  | 'tool_result'
  | 'approval'
  | 'assistant'
  | 'plan'
  | 'memory_read'
  | 'memory_write'
  | 'context_evicted'
  | 'budget_check'
  | 'subagent_dispatch'
  | 'subagent_result'
  | 'tool_policy'
  | (string & {});

export interface AgentStep {
  id: string;
  run_id: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string | null;
  sequence: number;
  kind: AgentStepKind;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'rejected';
  tool_call_id?: string | null;
  tool_key?: string | null;
  input?: unknown;
  output?: unknown;
  content?: string | null;
  duration_ms?: number | null;
  created_at: string;
}

export interface AgentApproval {
  id: string;
  run_id: string;
  step_id?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reason: string;
  expires_at: string;
  decided_at?: string | null;
  created_at: string;
}

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AgentGroundingSummary {
  status: 'supported' | 'partial' | 'unsupported' | 'not_applicable' | string;
  score: number;
  supported_source_count: number;
  reasons: string[];
  model_cited_labels?: number[];
  citation_decisions?: Array<Record<string, unknown>>;
}

export interface AgentRun {
  id: string;
  user_id: string;
  agent_id?: string | null;
  agent_version_id?: string | null;
  agent_version_snapshot?: Record<string, unknown>;
  conversation_id: string;
  user_message_id?: string | null;
  assistant_message_id?: string | null;
  status: AgentRunStatus;
  iteration_count: number;
  tool_call_count: number;
  token_usage: Record<string, number>;
  grounding?: AgentGroundingSummary | null;
  error_code?: string | null;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
}

export interface AgentRunDetail extends AgentRun {
  steps: AgentStep[];
  approvals: AgentApproval[];
  steps_has_more: boolean;
  approvals_has_more: boolean;
}

export interface AgentEvent {
  type: string;
  runId: string;
  agentId?: string;
  agentName?: string;
  toolCallId?: string;
  tool?: string;
  durationMs?: number;
  error?: string;
  approvalId?: string;
  riskLevel?: 'read' | 'write' | 'high';
  arguments?: unknown;
  expiresAt?: string;
  decision?: 'approved' | 'rejected' | 'expired';
  reason?: string;
  grounding?: AgentGroundingSummary;
  /** Human-readable one-liner for events the timeline renders as a plain note. */
  detail?: string;
  /** Set on subagent events so the timeline can nest a dispatched run's work. */
  subagentRunId?: string;
  subagentStatus?: 'succeeded' | 'failed' | 'cancelled';
}

export type AgentVisibility = 'private' | 'project';
export type AgentStatus = 'draft' | 'published' | 'disabled';
export type AgentMemoryMode = 'none' | 'conversation' | 'user' | 'project' | 'custom';
export type AgentMemoryScope = 'user' | 'project' | 'agent';
export type AgentMemorySourceTrust = 'user_stated' | 'agent_inferred' | 'tool_derived';

export interface AgentMemoryPolicy {
  format_version: 1;
  conversation: {
    enabled: boolean;
    message_limit: number;
    rolling_summary: { enabled: boolean; max_tokens: number };
  };
  persona: { enabled: boolean };
  project_context: { enabled: boolean };
  read: {
    allowed_scopes: AgentMemoryScope[];
    auto_recall: boolean;
    auto_scopes: AgentMemoryScope[];
    top_k: number;
    token_budget: number;
    min_trust: AgentMemorySourceTrust;
  };
  write: {
    enabled: boolean;
    allowed_scopes: AgentMemoryScope[];
    default_ttl_days: number | null;
    require_confirmation: boolean;
  };
  subagent: {
    share_recalled_memory: boolean;
    max_items: number;
    token_budget: number;
  };
}
export type AgentResponseFormat = 'markdown' | 'json';
export type AgentApprovalPolicy = 'never' | 'writes' | 'always';
export type AgentVersionChangeKind = 'created' | 'edited' | 'rollback';
export type AgentPublicationValidationStatus = 'passed' | 'failed' | 'not_applicable';
export type AgentDelegationMode = 'explicit' | 'legacy_dynamic';

export interface AgentDelegationBinding {
  alias: string;
  agent_id: string;
  version_policy: 'pinned';
  agent_version_id: string;
  role: string;
  max_parallelism: number;
  allowed_context_keys: string[];
}

export interface AgentToolBinding {
  key: string;
  enabled: boolean;
  tool_version_id?: string;
  configuration?: Record<string, unknown>;
}

export interface AgentPublicationValidationCheck {
  key: string;
  status: AgentPublicationValidationStatus;
  message: string;
}

export interface AgentPublicationValidationReport {
  format_version: 1;
  valid: boolean;
  checks: AgentPublicationValidationCheck[];
}

export interface AgentVersionPublication {
  id: string;
  agent_id: string;
  agent_version_id: string;
  published_by?: string | null;
  release_notes: string;
  validation_report: AgentPublicationValidationReport;
  published_at: string;
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
  configuration_hash: string;
  derived_from_version_id?: string | null;
  change_kind: AgentVersionChangeKind;
  published_version?: number | null;
  has_unpublished_changes: boolean;
  instructions: string;
  model: string;
  temperature: number;
  max_iterations: number;
  max_duration_ms: number;
  max_output_tokens: number;
  memory_mode: AgentMemoryMode;
  memory_policy: AgentMemoryPolicy;
  response_format: AgentResponseFormat;
  output_schema: Record<string, unknown>;
  approval_policy: AgentApprovalPolicy;
  tool_bindings: AgentToolBinding[];
  delegation_mode: AgentDelegationMode;
  delegation_bindings: AgentDelegationBinding[];
  welcome_message: string;
  suggested_prompts: string[];
  created_at: string;
  updated_at: string;
  version_created_at?: string;
  publication?: AgentVersionPublication;
}

export interface AgentVersion {
  id: string;
  agent_id: string;
  version: number;
  instructions: string;
  model: string;
  temperature: number;
  max_iterations: number;
  max_duration_ms: number;
  max_output_tokens: number;
  memory_mode: AgentMemoryMode;
  memory_policy: AgentMemoryPolicy;
  response_format: AgentResponseFormat;
  output_schema: Record<string, unknown>;
  approval_policy: AgentApprovalPolicy;
  tool_bindings: AgentToolBinding[];
  delegation_mode: AgentDelegationMode;
  delegation_bindings: AgentDelegationBinding[];
  welcome_message: string;
  suggested_prompts: string[];
  configuration_hash: string;
  derived_from_version_id?: string | null;
  change_kind: AgentVersionChangeKind;
  is_current: boolean;
  is_published: boolean;
  publication_id?: string | null;
  published_at?: string | null;
  published_by?: string | null;
  release_notes?: string | null;
  validation_report?: AgentPublicationValidationReport | null;
  created_at: string;
}

export interface AgentVersionFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface AgentVersionDiff {
  from: { id: string; version: number; configuration_hash: string };
  to: { id: string; version: number; configuration_hash: string };
  changed_fields: string[];
  changes: AgentVersionFieldChange[];
}

export interface AgentVersionDryRunToolCall {
  tool_call_id: string;
  tool_key: string;
  model_name: string;
  risk_level: 'read' | 'write' | 'high';
  policy_decision: 'execute' | 'approve' | 'reject';
  status: 'simulated' | 'invalid';
  arguments?: Record<string, unknown>;
  validation_error?: string;
}

export interface AgentVersionDryRun {
  id: string;
  user_id: string;
  agent_id: string;
  agent_version_id: string;
  status: 'running' | 'succeeded' | 'failed';
  input_text: string;
  output_text: string;
  validation_report: AgentPublicationValidationReport;
  planned_tool_calls: AgentVersionDryRunToolCall[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  isolation_report: {
    mode: 'model_only';
    blocked_effects: string[];
    omitted_context: string[];
  };
  failure_code?: string | null;
  failure_message?: string | null;
  created_at: string;
  completed_at?: string | null;
}

export interface AgentEvalExpectedToolCall {
  tool_key: string;
  arguments?: Record<string, unknown>;
  fixture?: unknown;
}

export interface AgentEvalEvaluationSpec {
  expected_output_contains?: string[];
  forbidden_output_contains?: string[];
  expected_tool_calls?: AgentEvalExpectedToolCall[];
  forbidden_tool_keys?: string[];
  grounding_evidence?: string[];
  expected_citations?: string[];
}

export interface AgentEvalCase {
  id: string;
  dataset_id: string;
  user_id: string;
  name: string;
  input_text: string;
  evaluation_spec: AgentEvalEvaluationSpec;
  created_at: string;
  updated_at: string;
}

export type AgentEvalRunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface AgentEvalResult {
  id: string;
  run_id: string;
  case_id: string;
  variant: 'candidate' | 'baseline';
  agent_id: string;
  agent_version_id: string;
  configuration_hash: string;
  status: 'succeeded' | 'failed';
  output_text: string;
  planned_tool_calls: AgentVersionDryRunToolCall[];
  metrics: Record<string, unknown>;
  usage: AgentVersionDryRun['usage'];
  latency_ms: number;
  failure_code?: string | null;
  failure_message?: string | null;
  created_at: string;
}

export interface AgentEvalRun {
  id: string;
  user_id: string;
  dataset_id: string;
  dataset_revision: number | string;
  agent_id: string;
  candidate_agent_version_id: string;
  candidate_configuration_hash: string;
  baseline_agent_version_id?: string | null;
  baseline_configuration_hash?: string | null;
  evaluator_version: string;
  status: AgentEvalRunStatus;
  case_count: number;
  result_count: number;
  failed_result_count: number;
  aggregate_metrics: {
    candidate?: Record<string, number | null>;
    baseline?: Record<string, number | null> | null;
    delta?: Record<string, number | null> | null;
    paired?: { wins: number; ties: number; losses: number } | null;
    isolation?: Record<string, unknown>;
  };
  usage: AgentVersionDryRun['usage'];
  validation_report: Record<string, unknown>;
  execution_snapshot: Record<string, unknown>;
  failure_code?: string | null;
  failure_message?: string | null;
  created_at: string;
  completed_at?: string | null;
  results?: AgentEvalResult[];
}

export interface AgentEvalDataset {
  id: string;
  user_id: string;
  name: string;
  description: string;
  revision: number | string;
  created_at: string;
  updated_at: string;
  cases: AgentEvalCase[];
  runs: AgentEvalRun[];
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
  max_invocations_per_run?: number | null;
  configuration: Record<string, unknown>;
  enabled: boolean;
  has_secrets: boolean;
  current_version_id: string;
  latest_version: number;
  tool_version_id: string;
  tool_version: number;
  secret_version: number;
  configuration_hash: string;
  derived_from_version_id?: string | null;
  change_kind: 'created' | 'edited' | 'secret_rotated';
  created_at: string;
  updated_at: string;
  tool_version_created_at: string;
}

export interface AgentToolVersion {
  id: string;
  tool_id: string;
  version: number;
  description: string;
  kind: 'http' | 'mcp';
  risk_level: 'read' | 'write' | 'high';
  max_invocations_per_run?: number | null;
  configuration: Record<string, unknown>;
  has_secrets: boolean;
  secret_version: number;
  configuration_hash: string;
  derived_from_version_id?: string | null;
  change_kind: 'created' | 'edited' | 'secret_rotated';
  is_current: boolean;
  created_at: string;
}

export interface AgentToolVersionDiff {
  from: { id: string; version: number; configuration_hash: string };
  to: { id: string; version: number; configuration_hash: string };
  changed_fields: string[];
  changes: AgentVersionFieldChange[];
}

export type AgentToolDiagnosticOperation = 'preflight' | 'safe_test' | 'discover';

export interface AgentToolDiagnosticCheck {
  key: 'configuration' | 'allowlist' | 'dns' | 'transport' | 'credentials' | 'operation_safety';
  status: 'passed' | 'warning' | 'failed';
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface DiscoveredMcpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

export interface AgentToolDiagnosticResult {
  tool_id: string;
  tool_version_id: string;
  configuration_hash: string;
  operation: AgentToolDiagnosticOperation;
  status: 'passed' | 'failed';
  live_request_attempted: boolean;
  checked_at: string;
  duration_ms: number;
  input_hash: string | null;
  checks: AgentToolDiagnosticCheck[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
  response?: {
    status: number;
    preview: {
      data: unknown;
      truncated: boolean;
      original_bytes: number;
      encoding: 'json' | 'json-prefix';
    };
  };
  discovery?: {
    protocol_version: string | null;
    server_info: { name: string; version: string } | null;
    capability_names: string[];
    tools: DiscoveredMcpTool[];
    selected_tool_found: boolean;
    truncated: boolean;
    warnings: string[];
  };
}

export interface AgentToolDiagnosticInput {
  operation: AgentToolDiagnosticOperation;
  input?: Record<string, unknown>;
}

export interface AgentToolDiagnosticHistoryEntry {
  id: string;
  tool_id: string;
  tool_version_id: string;
  configuration_hash: string;
  operation: AgentToolDiagnosticOperation;
  status: 'passed' | 'failed';
  live_request_attempted: boolean;
  passed_check_count: number;
  warning_check_count: number;
  failed_check_count: number;
  error_code: string | null;
  response_status: number | null;
  discovery_tool_count: number | null;
  discovery_warning_count: number | null;
  duration_ms: number;
  checked_at: string;
  created_at: string;
}

export interface AgentToolDiagnosticHistoryPage {
  items: AgentToolDiagnosticHistoryEntry[];
  next_cursor: string | null;
}

export interface AgentToolDiagnosticHistoryQuery {
  cursor?: string;
  limit?: number;
  operation?: AgentToolDiagnosticOperation;
  tool_version_id?: string;
}

export interface ImportedOpenApiOperation {
  key: string;
  operation_id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  name: string;
  description: string;
  endpoint: string;
  risk_level: 'read' | 'write';
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  suggested_secret_keys: string[];
  warnings: string[];
  configuration: {
    endpoint: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    idempotency_mode: 'none';
    timeout_ms: number;
    input_schema: Record<string, unknown>;
    static_headers: Record<string, string>;
    response_path: '';
    output_schema?: Record<string, unknown>;
  };
}

export interface OpenApiToolImportResult {
  title: string;
  version: string;
  operations: ImportedOpenApiOperation[];
  warnings: string[];
  truncated: boolean;
}

export interface OpenApiToolImportInput {
  document: Record<string, unknown>;
  base_url?: string;
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
  memory_policy?: AgentMemoryPolicy;
  response_format?: AgentResponseFormat;
  output_schema?: Record<string, unknown>;
  approval_policy?: AgentApprovalPolicy;
  tool_bindings?: AgentToolBinding[];
  delegation_bindings?: AgentDelegationBinding[];
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
  requested_by_run_id?: string | null;
  requested_by_agent_id?: string | null;
  requested_by_agent_name?: string | null;
  requested_by_depth?: number | null;
  requested_by_parent_run_id?: string | null;
  intent: AgentApprovalIntent;
  intent_hash: string;
  tool_call_id?: string | null;
  tool_key?: string | null;
  input?: unknown;
  output?: unknown;
  created_at: string;
}

export interface AgentApprovalIntent {
  format_version: 1;
  tool_key: string;
  tool_kind: 'builtin' | 'http' | 'mcp' | 'memory' | 'subagent';
  tool_version_id: string | null;
  configuration_hash: string | null;
  secret_version: number | null;
  input_hash: string;
  target: string | null;
  method: string;
  risk_level: 'read' | 'write' | 'high';
  policy_chain: AgentApprovalPolicy[];
  side_effect_summary: string;
}

export interface AgentApprovalInboxItem extends AgentApproval {
  root_run_status: AgentRunStatus;
  conversation_id: string;
  requesting_agent_id?: string | null;
  requesting_agent_name?: string | null;
  requesting_run_status: AgentRunStatus;
  requesting_depth: number;
  requesting_parent_run_id?: string | null;
}

export interface AgentApprovalInboxResponse {
  items: AgentApprovalInboxItem[];
  next_cursor: string | null;
}

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_subagent'
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
  requestedByRunId?: string;
  requestedByAgentId?: string;
  requestedByAgentName?: string;
  requestedByDepth?: number;
  approvalIntent?: AgentApprovalIntent;
  approvalIntentHash?: string;
  grounding?: AgentGroundingSummary;
  /** Human-readable one-liner for events the timeline renders as a plain note. */
  detail?: string;
  /** Set on subagent events so the timeline can nest a dispatched run's work. */
  subagentRunId?: string;
  subagentStatus?: 'succeeded' | 'failed' | 'cancelled';
}

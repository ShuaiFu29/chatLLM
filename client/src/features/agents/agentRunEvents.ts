import type { AgentApproval, AgentEvent, AgentGroundingSummary, AgentStep } from './types';

const readOutput = (step: AgentStep): Record<string, unknown> => (
  step.output && typeof step.output === 'object' && !Array.isArray(step.output)
    ? step.output as Record<string, unknown>
    : {}
);

const readNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const readText = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const SENSITIVE_ARGUMENT_KEY = /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|cookie|credential/i;

export const redactAgentApprovalArguments = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.map((entry) => redactAgentApprovalArguments(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_ARGUMENT_KEY.test(key) ? '[REDACTED]' : redactAgentApprovalArguments(entry, depth + 1),
    ]));
  }
  if (typeof value === 'string') {
    if (depth === 0) {
      try {
        return redactAgentApprovalArguments(JSON.parse(value), depth + 1);
      } catch {
        // A provider can return malformed arguments. Keep them inspectable while
        // still masking common inline credential forms.
      }
    }
    return value
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
      .replace(/([?&](?:api[-_]?key|access[-_]?token|token|secret|password)=)[^&#\s]*/gi, '$1[REDACTED]');
  }
  return value;
};

/**
 * Turn a runtime decision step into a one-line note for the timeline.
 *
 * The runtime records why it did what it did -- which memories were in scope, what
 * history it had to drop, which budget it hit, which tools the policy withheld,
 * what it delegated. None of that was rendered, so the interface showed a tool
 * loop while the reasoning behind it stayed in the database. Returning undefined
 * means "nothing worth showing", which keeps a step from producing an empty row.
 */
const describeDecisionStep = (step: AgentStep): string | undefined => {
  const output = readOutput(step);
  if (step.kind === 'memory_read') {
    const parts: string[] = [];
    const conversation = readNumber(output.conversation_messages);
    const durable = readNumber(output.durable_memories);
    if (conversation !== undefined) parts.push(`history ${conversation}`);
    if (durable) parts.push(`memories ${durable}`);
    if (output.includes_user_profile === true) parts.push('profile');
    if (output.includes_project_context === true) parts.push('project');
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }
  if (step.kind === 'memory_write') {
    return readText(output.scope) ? `scope ${output.scope}` : undefined;
  }
  if (step.kind === 'context_evicted') {
    const evicted = readNumber(output.evicted_messages);
    const before = readNumber(output.prompt_tokens_before);
    const after = readNumber(output.prompt_tokens_after);
    const parts: string[] = [];
    if (evicted !== undefined) parts.push(`dropped ${evicted}`);
    if (before !== undefined && after !== undefined) parts.push(`${before} → ${after} tokens`);
    if (output.digest_retained === true) parts.push('summarised');
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }
  if (step.kind === 'budget_check') {
    const limit = readText(output.limit);
    const action = readText(output.action);
    if (!limit) return undefined;
    return action ? `${limit} · ${action}` : limit;
  }
  if (step.kind === 'tool_policy') {
    const withheld = Array.isArray(output.withheld_tools) ? output.withheld_tools.length : 0;
    const available = Array.isArray(output.available_tools) ? output.available_tools.length : 0;
    const risk = readText(output.resolved_max_risk_level);
    const parts: string[] = [`tools ${available}`];
    // The withheld count is the part worth surfacing: it answers "why did the
    // Agent never use the tool I bound to it".
    if (withheld > 0) parts.push(`withheld ${withheld}`);
    if (risk) parts.push(`max ${risk}`);
    return parts.join(' · ');
  }
  if (step.kind === 'plan') {
    const total = readNumber(output.total) ?? readNumber(output.tasks);
    return total !== undefined ? `${total} subtasks` : undefined;
  }
  return undefined;
};

export const buildPersistedAgentEvents = (input: {
  runId: string;
  status?: 'queued' | 'running' | 'waiting_approval' | 'waiting_subagent' | 'succeeded' | 'failed' | 'cancelled' | null;
  steps?: AgentStep[];
  approvals?: AgentApproval[];
  grounding?: AgentGroundingSummary | null;
}): AgentEvent[] => {
  const events: AgentEvent[] = [{ type: 'run.started', runId: input.runId }];
  const approvalsByStep = new Map((input.approvals || []).map((approval) => [approval.step_id, approval]));
  const emittedApprovalIds = new Set<string>();
  const appendApprovalEvents = (approval: AgentApproval, step?: AgentStep) => {
    if (emittedApprovalIds.has(approval.id)) return;
    emittedApprovalIds.add(approval.id);
    const output = approval.output && typeof approval.output === 'object'
      ? approval.output as Record<string, unknown>
      : step ? readOutput(step) : {};
    const risk = output.risk_level;
    events.push({
      type: 'approval.required',
      runId: input.runId,
      approvalId: approval.id,
      toolCallId: approval.tool_call_id || step?.tool_call_id || undefined,
      tool: approval.tool_key || step?.tool_key || undefined,
      riskLevel: risk === 'read' || risk === 'write' || risk === 'high' ? risk : 'high',
      arguments: redactAgentApprovalArguments(
        approval.input !== undefined ? approval.input : step?.input,
      ),
      expiresAt: approval.expires_at,
      requestedByRunId: approval.requested_by_run_id || undefined,
      requestedByAgentId: approval.requested_by_agent_id || undefined,
      requestedByAgentName: approval.requested_by_agent_name || undefined,
      requestedByDepth: approval.requested_by_depth ?? undefined,
      approvalIntent: approval.intent,
      approvalIntentHash: approval.intent_hash,
    });
    if (approval.status !== 'pending') {
      events.push({
        type: 'approval.resolved',
        runId: input.runId,
        approvalId: approval.id,
        toolCallId: approval.tool_call_id || step?.tool_call_id || undefined,
        tool: approval.tool_key || step?.tool_key || undefined,
        // `expired` is its own outcome. Drawing it as `rejected` told the user
        // they had declined the tool when in fact nobody decided in time.
        decision: approval.status,
        reason: approval.reason || '',
        requestedByRunId: approval.requested_by_run_id || undefined,
        requestedByAgentId: approval.requested_by_agent_id || undefined,
        requestedByAgentName: approval.requested_by_agent_name || undefined,
        requestedByDepth: approval.requested_by_depth ?? undefined,
      });
    }
  };
  for (const step of input.steps || []) {
    if (step.kind === 'tool_call' && !['pending', 'rejected', 'cancelled'].includes(step.status)) {
      events.push({
        type: 'tool.started',
        runId: input.runId,
        toolCallId: step.tool_call_id || undefined,
        tool: step.tool_key || undefined,
      });
    }
    if (step.kind === 'approval') {
      const approval = approvalsByStep.get(step.id);
      if (!approval) continue;
      appendApprovalEvents(approval, step);
    }
    if (step.kind === 'tool_result') {
      events.push({
        type: step.status === 'succeeded' ? 'tool.completed' : 'tool.failed',
        runId: input.runId,
        toolCallId: step.tool_call_id || undefined,
        tool: step.tool_key || undefined,
        durationMs: step.duration_ms || undefined,
        // The runtime records a coded reason; showing it is the difference between
        // "a tool failed" and "the endpoint was not allowlisted".
        error: readText(readOutput(step).error),
        detail: readText(readOutput(step).message),
      });
    }
    if (step.kind === 'subagent_dispatch') {
      const output = readOutput(step);
      events.push({
        type: 'subagent.dispatched',
        runId: input.runId,
        toolCallId: step.tool_call_id || undefined,
        subagentRunId: readText(output.run_id),
        detail: readText(output.agent_name) || readText(output.task),
      });
    }
    if (step.kind === 'subagent_result') {
      const output = readOutput(step);
      const status = readText(output.status);
      events.push({
        type: 'subagent.completed',
        runId: input.runId,
        toolCallId: step.tool_call_id || undefined,
        subagentRunId: readText(output.run_id),
        subagentStatus: status === 'succeeded' || status === 'cancelled' ? status : 'failed',
        durationMs: step.duration_ms || undefined,
        error: readText(output.error),
        detail: readText(output.message),
      });
    }
    // Everything else the runtime chose to record. Rendered as a plain note rather
    // than given bespoke event types, so a future step kind degrades to a readable
    // line instead of disappearing.
    const decision = describeDecisionStep(step);
    if (decision) {
      events.push({
        type: `decision.${step.kind}`,
        runId: input.runId,
        detail: decision,
        durationMs: step.duration_ms || undefined,
      });
    }
  }
  // Bubbled subagent approvals point at a canonical step on the child Run, which
  // is intentionally absent from the root's own step list. The detail endpoint
  // projects the fields needed to render and decide it here without mirror steps.
  for (const approval of input.approvals || []) appendApprovalEvents(approval);
  if (input.status === 'succeeded') events.push({
    type: 'run.completed',
    runId: input.runId,
    ...(input.grounding ? { grounding: input.grounding } : {}),
  });
  if (input.status === 'failed') events.push({ type: 'run.failed', runId: input.runId });
  if (input.status === 'cancelled') events.push({ type: 'run.cancelled', runId: input.runId });
  return events;
};

const agentEventIdentity = (event: AgentEvent) => [
  event.type,
  event.approvalId || '',
  event.toolCallId || '',
  event.subagentRunId || '',
  event.type.startsWith('decision.') ? event.detail || '' : '',
].join(':');

/**
 * Add durable events that never travelled over the root SSE stream (notably a
 * child approval) without duplicating events the live stream already rendered.
 * Persisted fields win when both sides describe the same event because the
 * database is the decision system of record.
 */
export const mergeAgentEvents = (
  liveEvents: AgentEvent[] = [],
  persistedEvents: AgentEvent[] = [],
): AgentEvent[] => {
  const merged = [...liveEvents];
  const indexes = new Map(merged.map((event, index) => [agentEventIdentity(event), index]));
  for (const event of persistedEvents) {
    const identity = agentEventIdentity(event);
    const existingIndex = indexes.get(identity);
    if (existingIndex === undefined) {
      indexes.set(identity, merged.length);
      merged.push(event);
    } else {
      merged[existingIndex] = { ...merged[existingIndex], ...event };
    }
  }
  return merged;
};

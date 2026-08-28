import type { AgentApproval, AgentEvent, AgentGroundingSummary, AgentStep } from './types';

const readOutput = (step: AgentStep): Record<string, unknown> => (
  step.output && typeof step.output === 'object' && !Array.isArray(step.output)
    ? step.output as Record<string, unknown>
    : {}
);

const readNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const readText = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

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
      events.push({
        type: 'approval.required',
        runId: input.runId,
        approvalId: approval.id,
        toolCallId: step.tool_call_id || undefined,
      tool: step.tool_key || undefined,
        riskLevel: (() => {
          const value = step.output && typeof step.output === 'object'
            ? (step.output as Record<string, unknown>).risk_level
            : undefined;
          return value === 'read' || value === 'write' || value === 'high' ? value : 'high';
        })(),
        arguments: step.input,
        expiresAt: approval.expires_at,
      });
      if (approval.status !== 'pending') {
        events.push({
          type: 'approval.resolved',
          runId: input.runId,
          approvalId: approval.id,
          toolCallId: step.tool_call_id || undefined,
          tool: step.tool_key || undefined,
          // `expired` is its own outcome. Drawing it as `rejected` told the user
          // they had declined the tool when in fact nobody decided in time.
          decision: approval.status,
          reason: approval.reason || '',
        });
      }
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
  if (input.status === 'succeeded') events.push({
    type: 'run.completed',
    runId: input.runId,
    ...(input.grounding ? { grounding: input.grounding } : {}),
  });
  if (input.status === 'failed') events.push({ type: 'run.failed', runId: input.runId });
  if (input.status === 'cancelled') events.push({ type: 'run.cancelled', runId: input.runId });
  return events;
};

import type { AgentApproval, AgentEvent, AgentGroundingSummary, AgentStep } from './types';

export const buildPersistedAgentEvents = (input: {
  runId: string;
  status?: 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled' | null;
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
          decision: approval.status === 'approved' ? 'approved' : 'rejected',
          reason: approval.reason || (approval.status === 'expired' ? 'expired' : ''),
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

/**
 * In-process cancellation registry for Agent executions.
 *
 * The database remains the source of truth for cross-process cancellation;
 * this registry closes the latency gap for executions owned by this process,
 * especially while a custom HTTP/MCP tool is waiting on network I/O.
 */
interface AgentRunControl {
  userId: string;
  agentId: string;
  conversationId: string;
  projectSpaceId?: string | null;
  controller: AbortController;
}

const activeRuns = new Map<string, AgentRunControl>();

export const registerAgentRunControl = (runId: string, control: AgentRunControl) => {
  activeRuns.set(runId, control);
};

export const unregisterAgentRunControl = (runId: string, controller?: AbortController) => {
  const current = activeRuns.get(runId);
  if (current && (!controller || current.controller === controller)) activeRuns.delete(runId);
};

const abortMatchingRuns = (
  predicate: (control: AgentRunControl) => boolean,
  reason: string,
) => {
  let count = 0;
  for (const control of activeRuns.values()) {
    if (!predicate(control)) continue;
    control.controller.abort(new Error(reason));
    count += 1;
  }
  return count;
};

export const abortAgentRunInProcess = (runId: string, userId: string) => (
  abortMatchingRuns(
    (control) => control.userId === userId && activeRuns.get(runId) === control,
    'Agent run cancelled',
  ) > 0
);

export const abortAgentRunsForAgentInProcess = (
  agentId: string,
  userId: string,
  reason = 'Agent was disabled or deleted',
) => abortMatchingRuns(
  (control) => control.agentId === agentId && control.userId === userId,
  reason,
);

export const abortAgentRunsForProjectSpaceInProcess = (
  projectSpaceId: string,
  userId: string,
  reason = 'Project space cleanup cancelled the Agent run',
) => abortMatchingRuns(
  (control) => control.projectSpaceId === projectSpaceId && control.userId === userId,
  reason,
);

export const abortAgentRunsForConversationInProcess = (
  conversationId: string,
  userId: string,
  reason = 'Conversation cancellation stopped the Agent run',
) => abortMatchingRuns(
  (control) => control.conversationId === conversationId && control.userId === userId,
  reason,
);

import type { AgentEvent, AgentRunStatus } from '../features/agents/types';
import type { Message } from '../stores/chatStore.types';

/** Run statuses that mean the server is still working on the turn. */
export const ACTIVE_AGENT_RUN_STATUSES: AgentRunStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'waiting_subagent',
];

/** SSE events after which no further Agent progress can arrive. */
export const TERMINAL_AGENT_EVENT_TYPES = [
  'run.completed',
  'run.failed',
  'run.cancelled',
];

const hasTerminalAgentEvent = (events?: AgentEvent[]) => (
  (events || []).some((event) => TERMINAL_AGENT_EVENT_TYPES.includes(event.type))
);

/**
 * Does this message still have an Agent run that the server may be advancing?
 *
 * Two independent signals matter, because they arrive from different places:
 *
 * - `agent_run_status` comes from the messages API, so it is only present after
 *   a full page load or a refresh.
 * - `agentRunId` / `agentEvents` come from the live SSE stream. When the stream
 *   dies mid-run (proxy timeout, flaky network) the run keeps going server-side
 *   by design, and this is the only evidence the client has left.
 *
 * Relying on `agent_run_status` alone is why a dropped SSE connection froze the
 * timeline until the user reloaded the page.
 */
export const isMessageAgentRunRecoverable = (message: Message) => {
  if (message.role !== 'assistant') return false;
  if (ACTIVE_AGENT_RUN_STATUSES.includes(message.agent_run_status as AgentRunStatus)) return true;
  // A terminal status from the server wins over stale local run ids.
  if (message.agent_run_status) return false;
  const runId = message.agentRunId || message.agent_run_id;
  if (!runId) return false;
  return !hasTerminalAgentEvent(message.agentEvents);
};

/** Is any message in this conversation waiting on an Agent run? */
export const hasRecoverableAgentRun = (messages: Message[]) => (
  messages.some(isMessageAgentRunRecoverable)
);

const AGENT_EVENT_RUN_STATUS: Record<string, AgentRunStatus> = {
  'run.queued': 'queued',
  'run.started': 'running',
  'approval.required': 'waiting_approval',
  'approval.resolved': 'running',
  'subagent.dispatched': 'waiting_subagent',
  'subagent.completed': 'running',
  'tool.started': 'running',
  'tool.completed': 'running',
  'tool.failed': 'running',
  'run.completed': 'succeeded',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
};

/**
 * Run status implied by a live SSE event.
 *
 * The stream used to record only `agentRunId` and the raw event list, so a
 * message that was mid-run carried no status at all. Mirroring the status the
 * messages API would report keeps the recovery check working without a reload.
 */
export const agentRunStatusFromEvent = (eventType?: string) => (
  eventType ? AGENT_EVENT_RUN_STATUS[eventType] : undefined
);

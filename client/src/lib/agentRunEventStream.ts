import { TERMINAL_AGENT_EVENT_TYPES } from './agentRunRecovery';

export interface DurableAgentRunEventPayload extends Record<string, unknown> {
  agentRunId?: string;
  agentEvent?: { type?: string; [key: string]: unknown };
}

interface AgentEventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
}

export const subscribeAgentRunEvents = (input: {
  runId: string;
  afterId?: string;
  onEvent(payload: DurableAgentRunEventPayload, cursor: string): void;
  onError?(event: Event): void;
  createEventSource?: (url: string) => AgentEventSourceLike;
}) => {
  const params = new URLSearchParams();
  if (input.afterId) params.set('after', input.afterId);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const create = input.createEventSource
    || ((url: string) => new EventSource(url, { withCredentials: true }));
  const source = create(`/api/agent-runs/${encodeURIComponent(input.runId)}/events/stream${suffix}`);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };
  source.addEventListener('agent.run', (event) => {
    if (closed) return;
    let payload: DurableAgentRunEventPayload;
    try {
      payload = JSON.parse(event.data) as DurableAgentRunEventPayload;
    } catch {
      return;
    }
    input.onEvent(payload, event.lastEventId || input.afterId || '0');
    const type = payload.agentEvent?.type;
    if (type && TERMINAL_AGENT_EVENT_TYPES.includes(type)) close();
  });
  source.onerror = (event) => {
    if (!closed) input.onError?.(event);
  };
  return close;
};

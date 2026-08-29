import { describe, expect, it, vi } from 'vitest';
import { subscribeAgentRunEvents } from './agentRunEventStream';

describe('subscribeAgentRunEvents', () => {
  it('resumes from a durable cursor and closes on a terminal event', () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const close = vi.fn();
    const onEvent = vi.fn();
    const createEventSource = vi.fn(() => ({
      addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) => {
        listeners.set(type, listener);
      },
      close,
      onerror: null,
    }));
    subscribeAgentRunEvents({
      runId: 'run/with spaces',
      afterId: '41',
      onEvent,
      createEventSource,
    });
    expect(createEventSource).toHaveBeenCalledWith(
      '/api/agent-runs/run%2Fwith%20spaces/events/stream?after=41',
    );

    listeners.get('agent.run')?.({
      data: JSON.stringify({ agentEvent: { type: 'tool.completed' } }),
      lastEventId: '42',
    } as MessageEvent<string>);
    expect(onEvent).toHaveBeenLastCalledWith(
      { agentEvent: { type: 'tool.completed' } },
      '42',
    );
    expect(close).not.toHaveBeenCalled();

    listeners.get('agent.run')?.({
      data: JSON.stringify({ agentEvent: { type: 'run.completed' } }),
      lastEventId: '43',
    } as MessageEvent<string>);
    expect(close).toHaveBeenCalledOnce();
  });

  it('ignores malformed event data', () => {
    let listener: ((event: MessageEvent<string>) => void) | undefined;
    const onEvent = vi.fn();
    subscribeAgentRunEvents({
      runId: 'run-1',
      onEvent,
      createEventSource: () => ({
        addEventListener: (_type, next) => { listener = next; },
        close: vi.fn(),
        onerror: null,
      }),
    });
    listener?.({ data: '{', lastEventId: '1' } as MessageEvent<string>);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

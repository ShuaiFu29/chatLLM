import { describe, expect, test } from 'vitest';
import type { Message } from '../stores/chatStore.types';
import {
  agentRunStatusFromEvent,
  hasRecoverableAgentRun,
  isMessageAgentRunRecoverable,
} from './agentRunRecovery';

const assistant = (overrides: Partial<Message> = {}): Message => ({
  id: 'assistant-1',
  role: 'assistant',
  content: '',
  created_at: '2026-08-20T00:00:00.000Z',
  ...overrides,
});

describe('agent run recovery (P1-SSE-RECOVER)', () => {
  test('a run reported active by the messages API is recoverable', () => {
    expect(isMessageAgentRunRecoverable(assistant({ agent_run_status: 'running' }))).toBe(true);
    expect(isMessageAgentRunRecoverable(assistant({ agent_run_status: 'queued' }))).toBe(true);
    expect(isMessageAgentRunRecoverable(assistant({ agent_run_status: 'waiting_approval' }))).toBe(true);
    expect(isMessageAgentRunRecoverable(assistant({ agent_run_status: 'waiting_subagent' }))).toBe(true);
  });

  test('a live run known only from SSE is recoverable after the stream drops', () => {
    // This is the case that used to freeze the timeline: the stream had written
    // agentRunId and events but no status, so nothing triggered the poll.
    expect(isMessageAgentRunRecoverable(assistant({
      agentRunId: 'run-1',
      agentEvents: [{ type: 'run.started', runId: 'run-1' }],
    }))).toBe(true);
    expect(isMessageAgentRunRecoverable(assistant({
      agentRunId: 'run-1',
      agentEvents: [
        { type: 'run.started', runId: 'run-1' },
        { type: 'tool.started', runId: 'run-1', tool: 'agentic_rag' },
      ],
    }))).toBe(true);
  });

  test('a finished run is not polled', () => {
    for (const type of ['run.completed', 'run.failed', 'run.cancelled']) {
      expect(isMessageAgentRunRecoverable(assistant({
        agentRunId: 'run-1',
        agentEvents: [{ type: 'run.started', runId: 'run-1' }, { type, runId: 'run-1' }],
      }))).toBe(false);
    }
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(isMessageAgentRunRecoverable(assistant({ agent_run_status: status }))).toBe(false);
    }
  });

  test('a terminal server status wins over a stale local run id', () => {
    expect(isMessageAgentRunRecoverable(assistant({
      agent_run_status: 'succeeded',
      agentRunId: 'run-1',
      agentEvents: [{ type: 'run.started', runId: 'run-1' }],
    }))).toBe(false);
  });

  test('plain chat messages are never treated as Agent runs', () => {
    expect(isMessageAgentRunRecoverable(assistant({ content: 'plain answer' }))).toBe(false);
    expect(isMessageAgentRunRecoverable({
      id: 'user-1',
      role: 'user',
      content: 'hi',
      created_at: '2026-08-20T00:00:00.000Z',
      agent_run_status: 'running',
    })).toBe(false);
  });

  test('the conversation-level check finds a run anywhere in the thread', () => {
    expect(hasRecoverableAgentRun([
      { id: 'u1', role: 'user', content: 'q', created_at: '' },
      assistant({ id: 'a1', agent_run_status: 'succeeded' }),
      assistant({ id: 'a2', agentRunId: 'run-2', agentEvents: [{ type: 'run.started', runId: 'run-2' }] }),
    ])).toBe(true);
    expect(hasRecoverableAgentRun([
      { id: 'u1', role: 'user', content: 'q', created_at: '' },
      assistant({ id: 'a1', agent_run_status: 'succeeded' }),
    ])).toBe(false);
    expect(hasRecoverableAgentRun([])).toBe(false);
  });
});

describe('agent run status derived from live events', () => {
  test('progress events map to the status the messages API would report', () => {
    expect(agentRunStatusFromEvent('run.started')).toBe('running');
    expect(agentRunStatusFromEvent('tool.started')).toBe('running');
    expect(agentRunStatusFromEvent('approval.required')).toBe('waiting_approval');
    expect(agentRunStatusFromEvent('subagent.dispatched')).toBe('waiting_subagent');
    expect(agentRunStatusFromEvent('subagent.completed')).toBe('running');
    expect(agentRunStatusFromEvent('approval.resolved')).toBe('running');
    expect(agentRunStatusFromEvent('run.completed')).toBe('succeeded');
    expect(agentRunStatusFromEvent('run.failed')).toBe('failed');
    expect(agentRunStatusFromEvent('run.cancelled')).toBe('cancelled');
  });

  test('unknown or missing event types leave the status untouched', () => {
    expect(agentRunStatusFromEvent('something.else')).toBeUndefined();
    expect(agentRunStatusFromEvent(undefined)).toBeUndefined();
  });
});

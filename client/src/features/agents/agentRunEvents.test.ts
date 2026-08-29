import { describe, expect, it } from 'vitest';
import { buildPersistedAgentEvents, mergeAgentEvents } from './agentRunEvents';

const approvalIntent = {
  format_version: 1 as const,
  tool_key: 'custom:writer',
  tool_kind: 'http' as const,
  tool_version_id: '11111111-1111-4111-8111-111111111111',
  configuration_hash: 'a'.repeat(64),
  secret_version: 1,
  input_hash: 'b'.repeat(64),
  target: 'https://example.test/write',
  method: 'POST',
  risk_level: 'write' as const,
  policy_chain: ['writes' as const],
  side_effect_summary: 'Write to the configured external system.',
};

describe('buildPersistedAgentEvents', () => {
  it('reconstructs tool and approval events for a waiting run', () => {
    const events = buildPersistedAgentEvents({
      runId: 'run-1',
      status: 'waiting_approval',
      steps: [
        {
          id: 'step-tool',
          run_id: 'run-1',
          sequence: 0,
          kind: 'tool_call',
          status: 'pending',
          tool_call_id: 'call-1',
          tool_key: 'custom:tool-1',
          input: { value: 1 },
          created_at: '',
        },
        {
          id: 'step-approval',
          run_id: 'run-1',
          sequence: 1,
          kind: 'approval',
          status: 'pending',
          tool_call_id: 'call-1',
          tool_key: 'custom:tool-1',
          input: { value: 1 },
          output: { risk_level: 'write' },
          created_at: '',
        },
      ],
      approvals: [{
        id: 'approval-1',
        run_id: 'run-1',
        step_id: 'step-approval',
        status: 'pending',
        intent: approvalIntent,
        intent_hash: 'c'.repeat(64),
        reason: '',
        expires_at: '2030-01-01T00:00:00.000Z',
        created_at: '',
      }],
    });

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'approval.required',
    ]);
    expect(events[1]).toMatchObject({
      approvalId: 'approval-1',
      tool: 'custom:tool-1',
      riskLevel: 'write',
      arguments: { value: 1 },
      approvalIntent,
      approvalIntentHash: 'c'.repeat(64),
    });
  });

  it('reconstructs a terminal failure after a failed tool result', () => {
    const events = buildPersistedAgentEvents({
      runId: 'run-2',
      status: 'failed',
      steps: [{
        id: 'step-result',
        run_id: 'run-2',
        sequence: 0,
        kind: 'tool_result',
        status: 'failed',
        tool_call_id: 'call-2',
        tool_key: 'calculator',
        duration_ms: 12,
        created_at: '',
      }],
    });

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'tool.failed',
      'run.failed',
    ]);
  });
});

describe('approval outcomes (P3-EXPIRED-UI)', () => {
  const buildWithApprovalStatus = (status: 'approved' | 'rejected' | 'expired') => (
    buildPersistedAgentEvents({
      runId: 'run-3',
      status: 'failed',
      steps: [{
        id: 'step-approval',
        run_id: 'run-3',
        sequence: 0,
        kind: 'approval',
        status: status === 'approved' ? 'succeeded' : 'rejected',
        tool_call_id: 'call-3',
        tool_key: 'custom:writer',
        output: { risk_level: 'write' },
        created_at: '',
      }],
      approvals: [{
        id: 'approval-3',
        run_id: 'run-3',
        step_id: 'step-approval',
        status,
        intent: approvalIntent,
        intent_hash: 'c'.repeat(64),
        reason: '',
        expires_at: '2026-08-20T00:00:00.000Z',
        created_at: '',
      }],
    })
  );

  it('keeps an expired approval distinct from a rejection', () => {
    const resolved = buildWithApprovalStatus('expired')
      .find((event) => event.type === 'approval.resolved');
    // Reporting `rejected` told the user they had declined the tool, when in
    // fact the decision window closed without anyone acting.
    expect(resolved?.decision).toBe('expired');
  });

  it('still reports explicit decisions unchanged', () => {
    expect(buildWithApprovalStatus('approved')
      .find((event) => event.type === 'approval.resolved')?.decision).toBe('approved');
    expect(buildWithApprovalStatus('rejected')
      .find((event) => event.type === 'approval.resolved')?.decision).toBe('rejected');
  });
});

describe('bubbled subagent approvals (R0-APR-ROOT-UI)', () => {
  it('renders a child canonical step from the root approval projection', () => {
    const events = buildPersistedAgentEvents({
      runId: 'root-run',
      status: 'waiting_subagent',
      steps: [],
      approvals: [{
        id: 'approval-child',
        run_id: 'root-run',
        step_id: 'child-step-not-in-root-list',
        status: 'pending',
        intent: approvalIntent,
        intent_hash: 'c'.repeat(64),
        reason: '',
        expires_at: '2030-01-01T00:00:00.000Z',
        requested_by_run_id: 'child-run',
        requested_by_agent_id: 'agent-researcher',
        requested_by_agent_name: 'Researcher',
        requested_by_depth: 2,
        tool_call_id: 'call-write',
        tool_key: 'custom:writer',
        input: {
          title: 'Draft',
          headers: { Authorization: 'Bearer private-token' },
          url: 'https://example.test/write?access_token=private',
        },
        output: { risk_level: 'write' },
        created_at: '',
      }],
    });

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'approval.required',
      runId: 'root-run',
      approvalId: 'approval-child',
      tool: 'custom:writer',
      riskLevel: 'write',
      arguments: {
        title: 'Draft',
        headers: { Authorization: '[REDACTED]' },
        url: 'https://example.test/write?access_token=[REDACTED]',
      },
      requestedByRunId: 'child-run',
      requestedByAgentId: 'agent-researcher',
      requestedByAgentName: 'Researcher',
      requestedByDepth: 2,
    });
  });

  it('merges a database-only child approval into an already-live timeline', () => {
    const events = mergeAgentEvents(
      [
        { type: 'run.started', runId: 'root-run', agentName: 'Root' },
        { type: 'subagent.dispatched', runId: 'root-run', toolCallId: 'dispatch-1' },
      ],
      [
        { type: 'run.started', runId: 'root-run' },
        {
          type: 'approval.required',
          runId: 'root-run',
          approvalId: 'approval-child',
          requestedByRunId: 'child-run',
        },
      ],
    );

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'run.started', agentName: 'Root' });
    expect(events[2]).toMatchObject({
      type: 'approval.required',
      approvalId: 'approval-child',
      requestedByRunId: 'child-run',
    });
  });
});

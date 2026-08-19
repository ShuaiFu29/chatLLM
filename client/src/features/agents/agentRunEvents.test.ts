import { describe, expect, it } from 'vitest';
import { buildPersistedAgentEvents } from './agentRunEvents';

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

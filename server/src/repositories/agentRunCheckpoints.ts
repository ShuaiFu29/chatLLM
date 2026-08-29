import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';
import type { AgentApprovalIntent } from '../modules/agents/runtime/agent-approval-intent';

export type AgentRunCheckpointBoundary =
  | 'execution_ready'
  | 'model_ready'
  | 'tool_batch_ready'
  | 'approval_wait'
  | 'subagents_wait'
  | 'final_answer_ready';

export interface AgentRunCheckpointRow {
  run_id: string;
  root_run_id: string;
  generation: number;
  format_version: 1;
  boundary: AgentRunCheckpointBoundary;
  payload: Record<string, unknown>;
  state_hash: string;
  owner_lease_token: string | null;
  created_at: string;
  updated_at: string;
}

const checkpointColumns = `
  run_id, root_run_id, generation, format_version, boundary, payload, state_hash,
  owner_lease_token, created_at, updated_at
`;

/**
 * Persist the latest safe continuation boundary with optimistic fencing.
 *
 * A root Run currently has no lease and is fenced by generation. A delegated
 * Run must additionally present its current lease token. When either fence is
 * stale this returns null; the caller must stop rather than continue executing.
 */
export const saveAgentRunCheckpoint = async (input: {
  runId: string;
  userId: string;
  expectedGeneration: number;
  leaseToken?: string | null;
  boundary: AgentRunCheckpointBoundary;
  payload: Record<string, unknown>;
  stateHash: string;
}) => {
  const { rows } = await query<AgentRunCheckpointRow>(
    `with owner as (
       select run.id, run.root_run_id, work.lease_token
       from agent_runs run
       join agent_work_items work on work.run_id = run.id
       where run.id = $1
         and run.user_id = $2
         and run.status in ('running', 'waiting_approval', 'waiting_subagent')
         and work.status = 'running'
         and work.lease_token = $3::uuid
         and work.lease_expires_at > now()
     ), candidate as (
       select owner.*, checkpoint.generation as existing_generation
       from owner
       left join agent_run_checkpoints checkpoint on checkpoint.run_id = owner.id
       where ($4 = 0 and checkpoint.run_id is null)
          or ($4 > 0 and checkpoint.generation = $4)
     )
     insert into agent_run_checkpoints (
       run_id, root_run_id, generation, format_version, boundary, payload, state_hash,
       owner_lease_token
     )
     select candidate.id, candidate.root_run_id, 1, 1, $5, $6::jsonb, $7, candidate.lease_token
     from candidate
     on conflict (run_id) do update
       set generation = agent_run_checkpoints.generation + 1,
           format_version = excluded.format_version,
           boundary = excluded.boundary,
           payload = excluded.payload,
           state_hash = excluded.state_hash,
           owner_lease_token = excluded.owner_lease_token,
           updated_at = now()
       where agent_run_checkpoints.generation = $4
     returning ${checkpointColumns}`,
    [
      input.runId,
      input.userId,
      input.leaseToken || null,
      input.expectedGeneration,
      input.boundary,
      JSON.stringify(input.payload),
      input.stateHash,
    ],
  );
  return rows[0] || null;
};

export const findAgentRunCheckpointForUser = async (runId: string, userId: string) => {
  const { rows } = await query<AgentRunCheckpointRow>(
    `select ${checkpointColumns.split(',').map((column) => `checkpoint.${column.trim()}`).join(', ')}
     from agent_run_checkpoints checkpoint
     join agent_runs run on run.id = checkpoint.run_id
     where checkpoint.run_id = $1 and run.user_id = $2`,
    [runId, userId],
  );
  return rows[0] || null;
};

export interface AgentRecoveryApprovalRow {
  id: string;
  run_id: string;
  step_id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reason: string | null;
  expires_at: string;
  decided_at: string | null;
  requested_by_run_id: string | null;
  intent: AgentApprovalIntent;
  intent_hash: string;
  created_at: string;
}

export type AgentRecoveryApprovalCommit =
  | { kind: 'existing'; approval: AgentRecoveryApprovalRow }
  | {
    kind: 'committed';
    approval: AgentRecoveryApprovalRow;
    checkpoint: AgentRunCheckpointRow;
  }
  | null;

/**
 * Create (or reuse) the next approval and publish its checkpoint atomically.
 * Returning `existing` lets the caller rebuild the checkpoint with an approval
 * created by a worker that died in the old row-before-checkpoint window.
 */
export const createAgentRecoveryApprovalCheckpoint = async (input: {
  workItemId: string;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
  runId: string;
  rootRunId: string;
  userId: string;
  approvalId: string;
  toolCallStepId: string;
  approvalStepId: string;
  toolCallSequence: number;
  approvalSequence: number;
  toolCallId: string;
  toolKey: string;
  riskLevel: string;
  args: Record<string, unknown>;
  intent: AgentApprovalIntent;
  intentHash: string;
  expiresAt: string;
  iterationCount: number;
  toolCallCount: number;
  tokenUsage: Record<string, number>;
  expectedGeneration: number;
  checkpointPayload: Record<string, unknown>;
  checkpointStateHash: string;
}): Promise<AgentRecoveryApprovalCommit> => {
  const stepPayloadBytes = Buffer.byteLength(JSON.stringify(input.args), 'utf8');
  if (stepPayloadBytes > serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES) {
    throw new Error('Agent recovery approval arguments exceed the Step payload limit');
  }
  return withTransaction(async (client) => {
    const { rows: ownerRows } = await client.query<{ root_run_id: string }>(
      `select requester.root_run_id
       from agent_runs requester
       join agent_runs root on root.id = requester.root_run_id
       join agent_work_items work on work.run_id = requester.id
       join agent_run_checkpoints checkpoint on checkpoint.run_id = requester.id
       where requester.id = $1 and requester.user_id = $2
         and requester.root_run_id = $3
         and requester.status in ('running', 'waiting_approval', 'waiting_subagent')
         and root.user_id = $2
         and root.status in ('running', 'waiting_approval', 'waiting_subagent')
         and work.id = $4 and work.status = 'running'
         and work.lease_token = $5 and work.fencing_generation = $6
         and work.lease_expires_at > now()
         and checkpoint.generation = $7
       for update of requester, root, work, checkpoint`,
      [
        input.runId,
        input.userId,
        input.rootRunId,
        input.workItemId,
        input.workItemLeaseToken,
        input.workItemFencingGeneration,
        input.expectedGeneration,
      ],
    );
    if (!ownerRows[0]) return null;

    const { rows: existingRows } = await client.query<AgentRecoveryApprovalRow>(
      `select approval.id, approval.run_id, approval.step_id, approval.user_id,
              approval.status, approval.reason, approval.expires_at,
              approval.decided_at, approval.requested_by_run_id,
              approval.intent, approval.intent_hash, approval.created_at
       from agent_approvals approval
       join agent_steps step on step.id = approval.step_id
       where approval.run_id = $1 and approval.user_id = $2
         and coalesce(approval.requested_by_run_id, approval.run_id) = $3
         and step.run_id = $3 and step.tool_call_id = $4
       order by approval.created_at
       limit 1
       for update of approval, step`,
      [input.rootRunId, input.userId, input.runId, input.toolCallId],
    );
    let approval = existingRows[0] || null;
    if (approval && approval.id !== input.approvalId) {
      return { kind: 'existing' as const, approval };
    }

    if (!approval) {
      const { rows: toolStepRows } = await client.query<{ id: string }>(
        `select id
         from agent_steps
         where run_id = $1 and kind = 'tool_call' and tool_call_id = $2
         order by sequence desc
         limit 1
         for update`,
        [input.runId, input.toolCallId],
      );
      let toolCallStepId = toolStepRows[0]?.id || null;
      if (!toolCallStepId) {
        const { rows } = await client.query<{ id: string }>(
          `insert into agent_steps (
             id, run_id, trace_id, sequence, kind, status, tool_call_id, tool_key, input
           ) values ($1, $2, $3, $4, 'tool_call', 'pending', $5, $6, $7::jsonb)
           returning id`,
          [
            input.toolCallStepId,
            input.runId,
            input.rootRunId,
            input.toolCallSequence,
            input.toolCallId,
            input.toolKey,
            JSON.stringify(input.args),
          ],
        );
        toolCallStepId = rows[0]?.id || null;
      }
      if (!toolCallStepId) throw new Error('Agent recovery tool Step could not be created');

      const { rows: approvalStepRows } = await client.query<{ id: string }>(
        `insert into agent_steps (
           id, run_id, trace_id, sequence, kind, status, tool_call_id, tool_key, input, output
         ) values (
           $1, $2, $3, $4, 'approval', 'pending', $5, $6, $7::jsonb,
           jsonb_build_object('risk_level', $8::text, 'recovered', true)
         )
         returning id`,
        [
          input.approvalStepId,
          input.runId,
          input.rootRunId,
          input.approvalSequence,
          input.toolCallId,
          input.toolKey,
          JSON.stringify(input.args),
          input.riskLevel,
        ],
      );
      if (!approvalStepRows[0]) throw new Error('Agent recovery approval Step could not be created');
      const { rows: createdRows } = await client.query<AgentRecoveryApprovalRow>(
        `insert into agent_approvals (
           id, run_id, step_id, user_id, status, expires_at, requested_by_run_id,
           intent, intent_hash
         ) values ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb, $8)
          returning id, run_id, step_id, user_id, status, reason, expires_at,
                    decided_at, requested_by_run_id, intent, intent_hash, created_at`,
        [
          input.approvalId,
          input.rootRunId,
          input.approvalStepId,
          input.userId,
          input.expiresAt,
          input.runId === input.rootRunId ? null : input.runId,
          JSON.stringify(input.intent),
          input.intentHash,
        ],
      );
      approval = createdRows[0] || null;
      if (!approval) throw new Error('Agent recovery approval could not be created');
    }

    const { rowCount: runUpdateCount } = await client.query(
      `update agent_runs
       set status = 'waiting_approval', iteration_count = $2,
           tool_call_count = $3, token_usage = $4::jsonb
       where id = $1 and user_id = $5
         and status in ('running', 'waiting_approval', 'waiting_subagent')`,
      [
        input.runId,
        input.iterationCount,
        input.toolCallCount,
        JSON.stringify(input.tokenUsage),
        input.userId,
      ],
    );
    if (runUpdateCount !== 1) throw new Error('Agent recovery approval Run is no longer active');

    const { rows: checkpointRows } = await client.query<AgentRunCheckpointRow>(
      `update agent_run_checkpoints
       set generation = generation + 1, format_version = 1,
           boundary = 'approval_wait', payload = $3::jsonb, state_hash = $4,
           owner_lease_token = $5, updated_at = now()
       where run_id = $1 and generation = $2
       returning ${checkpointColumns}`,
      [
        input.runId,
        input.expectedGeneration,
        JSON.stringify(input.checkpointPayload),
        input.checkpointStateHash,
        input.workItemLeaseToken,
      ],
    );
    const checkpoint = checkpointRows[0] || null;
    if (!checkpoint) throw new Error('Agent recovery approval checkpoint lost ownership');
    return { kind: 'committed' as const, approval, checkpoint };
  });
};

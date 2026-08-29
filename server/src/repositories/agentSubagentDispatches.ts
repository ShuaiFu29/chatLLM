import { createHash } from 'node:crypto';
import { serverEnv } from '../lib/env';
import { withTransaction } from '../lib/db';
import { insertAgentWorkItem } from './agentWorkItems';

export interface DurableSubagentDispatchFailureOutcome extends Record<string, unknown> {
  taskIndex: number;
  agentId: string;
  status: 'failed';
  error: string;
  message: string;
  durationMs: number;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface DurableSubagentChildPlan {
  kind: 'child';
  taskIndex: number;
  agentId: string;
  agentVersionId: string;
  agentVersionSnapshot: Record<string, unknown>;
  workItemPayload: Record<string, unknown>;
}

export interface DurableSubagentFailurePlan {
  kind: 'failure';
  taskIndex: number;
  outcome: DurableSubagentDispatchFailureOutcome;
}

export interface DurableSubagentDispatchPlan {
  formatVersion: 1;
  mode: 'parallel' | 'sequential';
  tasks: Array<DurableSubagentChildPlan | DurableSubagentFailurePlan>;
}

export interface AgentSubagentDispatchRow {
  id: string;
  parent_run_id: string;
  root_run_id: string;
  user_id: string;
  parent_tool_call_id: string;
  mode: 'parallel' | 'sequential';
  format_version: 1;
  plan: DurableSubagentDispatchPlan;
  plan_text: string;
  plan_hash: string;
  status: 'planned' | 'materializing' | 'materialized';
  next_task_index: number;
  created_child_count: number;
  expected_child_count: number | null;
  immediate_outcomes: DurableSubagentDispatchFailureOutcome[];
  created_at: string;
  materialized_at: string | null;
  updated_at: string;
}

const dispatchColumns = `
  id, parent_run_id, root_run_id, user_id, parent_tool_call_id, mode,
  format_version, plan, plan::text as plan_text, plan_hash, status,
  next_task_index, created_child_count, expected_child_count,
  immediate_outcomes, created_at, materialized_at, updated_at
`;

const dispatchColumnsWithAlias = `
  dispatch.id, dispatch.parent_run_id, dispatch.root_run_id, dispatch.user_id,
  dispatch.parent_tool_call_id, dispatch.mode, dispatch.format_version,
  dispatch.plan, dispatch.plan::text as plan_text, dispatch.plan_hash,
  dispatch.status, dispatch.next_task_index, dispatch.created_child_count,
  dispatch.expected_child_count, dispatch.immediate_outcomes,
  dispatch.created_at, dispatch.materialized_at, dispatch.updated_at
`;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const emptyUsage = () => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

const failureOutcome = (
  taskIndex: number,
  agentId: string,
  error: string,
  message: string,
): DurableSubagentDispatchFailureOutcome => ({
  taskIndex,
  agentId,
  status: 'failed',
  error,
  message,
  durationMs: 0,
  usage: emptyUsage(),
});

const validateFailureOutcome = (value: unknown): DurableSubagentDispatchFailureOutcome => {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.taskIndex)
    || Number(value.taskIndex) < 0
    || typeof value.agentId !== 'string'
    || value.status !== 'failed'
    || typeof value.error !== 'string'
    || typeof value.message !== 'string'
    || typeof value.durationMs !== 'number'
    || !isRecord(value.usage)
  ) throw new Error('Agent subagent dispatch failure outcome is invalid');
  return structuredClone(value) as DurableSubagentDispatchFailureOutcome;
};

export const validateDurableSubagentDispatchPlan = (
  value: unknown,
): DurableSubagentDispatchPlan => {
  if (
    !isRecord(value)
    || value.formatVersion !== 1
    || !['parallel', 'sequential'].includes(String(value.mode))
    || !Array.isArray(value.tasks)
    || value.tasks.length < 1
    || value.tasks.length > serverEnv.AGENT_MAX_SUBAGENT_FANOUT
  ) throw new Error('Agent subagent dispatch plan is invalid');
  const rawTasks = value.tasks as unknown[];
  const indexes = new Set<number>();
  const tasks = rawTasks.map((raw) => {
    if (
      !isRecord(raw)
      || !Number.isSafeInteger(raw.taskIndex)
      || Number(raw.taskIndex) < 0
      || Number(raw.taskIndex) >= rawTasks.length
      || indexes.has(Number(raw.taskIndex))
    ) throw new Error('Agent subagent dispatch task index is invalid');
    const taskIndex = Number(raw.taskIndex);
    indexes.add(taskIndex);
    if (raw.kind === 'failure') {
      const outcome = validateFailureOutcome(raw.outcome);
      if (outcome.taskIndex !== taskIndex) {
        throw new Error('Agent subagent dispatch failure task index is inconsistent');
      }
      return {
        kind: 'failure' as const,
        taskIndex,
        outcome,
      };
    }
    if (
      raw.kind !== 'child'
      || typeof raw.agentId !== 'string'
      || !raw.agentId
      || typeof raw.agentVersionId !== 'string'
      || !raw.agentVersionId
      || !isRecord(raw.agentVersionSnapshot)
      || !isRecord(raw.workItemPayload)
    ) throw new Error('Agent subagent child plan is invalid');
    return {
      kind: 'child' as const,
      taskIndex,
      agentId: raw.agentId,
      agentVersionId: raw.agentVersionId,
      agentVersionSnapshot: structuredClone(raw.agentVersionSnapshot),
      workItemPayload: structuredClone(raw.workItemPayload),
    };
  });
  if (indexes.size !== rawTasks.length) {
    throw new Error('Agent subagent dispatch task indexes are incomplete');
  }
  tasks.sort((left, right) => left.taskIndex - right.taskIndex);
  return {
    formatVersion: 1,
    mode: value.mode as 'parallel' | 'sequential',
    tasks,
  };
};

const preparePlan = (plan: DurableSubagentDispatchPlan) => {
  const normalized = validateDurableSubagentDispatchPlan(plan);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > Math.min(
    serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES,
    262_144,
  )) throw new Error('Agent subagent dispatch plan exceeds its durable payload limit');
  return { normalized, serialized };
};

const restoreDispatch = (row: AgentSubagentDispatchRow) => {
  if (typeof row.plan_text !== 'string' || !row.plan_text.startsWith('{')) {
    throw new Error('Agent subagent dispatch canonical plan is missing');
  }
  const hash = createHash('sha256').update(row.plan_text).digest('hex');
  if (hash !== row.plan_hash) throw new Error('Agent subagent dispatch plan hash does not match');
  const parsed = validateDurableSubagentDispatchPlan(JSON.parse(row.plan_text));
  if (parsed.mode !== row.mode || row.format_version !== 1) {
    throw new Error('Agent subagent dispatch plan metadata is inconsistent');
  }
  if (
    !Number.isSafeInteger(row.next_task_index)
    || row.next_task_index < 0
    || row.next_task_index > parsed.tasks.length
    || !Number.isSafeInteger(row.created_child_count)
    || row.created_child_count < 0
    || row.created_child_count > row.next_task_index
    || (
      row.status === 'materialized'
      && row.expected_child_count !== row.created_child_count
    )
  ) throw new Error('Agent subagent dispatch cursor is inconsistent');
  const immediateOutcomes = row.immediate_outcomes.map(validateFailureOutcome);
  if (
    new Set(immediateOutcomes.map((outcome) => outcome.taskIndex)).size
      !== immediateOutcomes.length
    || immediateOutcomes.some((outcome) => outcome.taskIndex >= row.next_task_index)
  ) throw new Error('Agent subagent dispatch immediate outcomes are inconsistent');
  return {
    ...row,
    plan: parsed,
    immediate_outcomes: immediateOutcomes,
  };
};

/**
 * Pin the first fully prepared fan-out under the current Work Item claim.
 * Competing or restarted workers always reuse the committed manifest instead of
 * rebuilding child snapshots from mutable Agent configuration.
 */
export const getOrCreateAgentSubagentDispatch = async (input: {
  workItemId: string;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
  parentRunId: string;
  rootRunId: string;
  userId: string;
  parentToolCallId: string;
  plan: DurableSubagentDispatchPlan;
}) => {
  const prepared = preparePlan(input.plan);
  return withTransaction(async (client) => {
    const { rows: ownerRows } = await client.query<{ id: string }>(
      `select work.id
       from agent_work_items work
       join agent_runs run on run.id = work.run_id
       where work.id = $1 and work.run_id = $2 and work.root_run_id = $3
         and work.user_id = $4 and work.status = 'running'
         and work.lease_token = $5 and work.fencing_generation = $6
         and work.lease_expires_at > now()
         and run.status in ('running', 'waiting_subagent')
       for update of work`,
      [
        input.workItemId,
        input.parentRunId,
        input.rootRunId,
        input.userId,
        input.workItemLeaseToken,
        input.workItemFencingGeneration,
      ],
    );
    if (!ownerRows[0]) return null;
    await client.query(
      `insert into agent_subagent_dispatches (
         parent_run_id, root_run_id, user_id, parent_tool_call_id, mode,
         format_version, plan, plan_hash
       ) values (
         $1, $2, $3, $4, $5, 1, $6::jsonb,
         encode(digest(($6::jsonb)::text, 'sha256'), 'hex')
       ) on conflict (parent_run_id, parent_tool_call_id) do nothing`,
      [
        input.parentRunId,
        input.rootRunId,
        input.userId,
        input.parentToolCallId,
        prepared.normalized.mode,
        prepared.serialized,
      ],
    );
    const { rows } = await client.query<AgentSubagentDispatchRow>(
      `select ${dispatchColumns}
       from agent_subagent_dispatches
       where parent_run_id = $1 and parent_tool_call_id = $2
       for update`,
      [input.parentRunId, input.parentToolCallId],
    );
    const row = rows[0];
    if (!row || row.root_run_id !== input.rootRunId || row.user_id !== input.userId) {
      throw new Error('Agent subagent dispatch identity conflict');
    }
    return restoreDispatch(row);
  });
};

export const findAgentSubagentDispatch = async (input: {
  parentRunId: string;
  parentToolCallId: string;
  userId: string;
}) => withTransaction(async (client) => {
  const { rows } = await client.query<AgentSubagentDispatchRow>(
    `select ${dispatchColumns}
     from agent_subagent_dispatches
     where parent_run_id = $1 and parent_tool_call_id = $2 and user_id = $3`,
    [input.parentRunId, input.parentToolCallId, input.userId],
  );
  return rows[0] ? restoreDispatch(rows[0]) : null;
});

const childInsertColumns = `
  id, root_run_id, parent_run_id, parent_tool_call_id, depth,
  user_id, agent_id, agent_version_id, conversation_id, status
`;

/**
 * Materialize a parallel batch atomically, or advance a sequential batch by one
 * child. The manifest row is the cursor, so retries cannot debit fan-out budget
 * twice or create the same task under a different Agent snapshot.
 */
export const materializeAgentSubagentDispatch = async (input: {
  dispatchId: string;
  workItemId: string;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
}) => withTransaction(async (client) => {
  const { rows: dispatchRows } = await client.query<AgentSubagentDispatchRow & {
    parent_depth: number;
    parent_ancestor_agent_ids: string[];
    parent_agent_id: string | null;
    conversation_id: string;
    parent_work_item_id: string;
  }>(
    `select ${dispatchColumnsWithAlias},
            parent.depth as parent_depth,
            parent.ancestor_agent_ids as parent_ancestor_agent_ids,
            parent.agent_id as parent_agent_id,
            parent.conversation_id,
            work.id as parent_work_item_id
     from agent_subagent_dispatches dispatch
     join agent_runs parent on parent.id = dispatch.parent_run_id
     join agent_work_items work on work.run_id = parent.id
     join agent_run_checkpoints checkpoint on checkpoint.run_id = parent.id
     where dispatch.id = $1
       and work.id = $2 and work.status = 'running'
       and work.lease_token = $3 and work.fencing_generation = $4
       and work.lease_expires_at > now()
       and parent.status in ('running', 'waiting_subagent')
       and checkpoint.boundary = 'subagents_wait'
       and checkpoint.payload #>> '{pending,toolCallId}' = dispatch.parent_tool_call_id
     for update of dispatch, parent, work`,
    [
      input.dispatchId,
      input.workItemId,
      input.workItemLeaseToken,
      input.workItemFencingGeneration,
    ],
  );
  const raw = dispatchRows[0];
  if (!raw) return null;
  const dispatch = restoreDispatch(raw);
  const { rows: childStateRows } = await client.query<{
    child_count: number;
    active_child_count: number;
  }>(
    `select
       count(*)::int as child_count,
       count(*) filter (
         where status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
       )::int as active_child_count
     from agent_runs
     where parent_run_id = $1 and parent_tool_call_id = $2`,
    [dispatch.parent_run_id, dispatch.parent_tool_call_id],
  );
  const childState = childStateRows[0];
  if (!childState || childState.child_count !== dispatch.created_child_count) {
    throw new Error('Agent subagent dispatch child count is inconsistent');
  }
  if (dispatch.status === 'materialized') return dispatch;
  // A sequential cursor may only move after the child created by its previous
  // turn is terminal. This remains true even if a stray wake-up job is delivered.
  if (dispatch.mode === 'sequential' && childState.active_child_count > 0) {
    return dispatch;
  }

  const immediate = [...dispatch.immediate_outcomes];
  let nextTaskIndex = dispatch.next_task_index;
  let createdChildCount = dispatch.created_child_count;
  const depth = raw.parent_depth + 1;
  const ancestorAgentIds = [
    ...raw.parent_ancestor_agent_ids,
    ...(raw.parent_agent_id ? [raw.parent_agent_id] : []),
  ];

  const appendFailure = (plan: DurableSubagentChildPlan, error: string, message: string) => {
    immediate.push(failureOutcome(plan.taskIndex, plan.agentId, error, message));
  };
  const createChild = async (plan: DurableSubagentChildPlan) => {
    if (depth > serverEnv.AGENT_MAX_SUBAGENT_DEPTH) {
      appendFailure(plan, 'subagent_depth_exceeded',
        `Subagent nesting is limited to ${serverEnv.AGENT_MAX_SUBAGENT_DEPTH} levels`);
      return false;
    }
    if (ancestorAgentIds.includes(plan.agentId)) {
      appendFailure(plan, 'subagent_cycle_detected',
        'That Agent is already running higher up in this task');
      return false;
    }
    const { rows: budgetRows } = await client.query<{ deadline_at: string }>(
      `update agent_run_budgets
       set subagent_dispatch_consumed = subagent_dispatch_consumed + 1,
           updated_at = now()
       where root_run_id = $1 and deadline_at > now()
         and subagent_dispatch_consumed + 1 <= subagent_dispatch_total
       returning deadline_at`,
      [dispatch.root_run_id],
    );
    if (!budgetRows[0]) {
      const { rows } = await client.query<{ deadline_at: string }>(
        `select deadline_at from agent_run_budgets where root_run_id = $1`,
        [dispatch.root_run_id],
      );
      const deadlineExceeded = Boolean(
        rows[0] && new Date(rows[0].deadline_at).getTime() <= Date.now(),
      );
      appendFailure(
        plan,
        deadlineExceeded ? 'subagent_deadline_exceeded' : 'subagent_budget_exhausted',
        deadlineExceeded
          ? 'The Agent task deadline has already elapsed'
          : 'The Agent task has no remaining subagent dispatch allowance',
      );
      return false;
    }
    const { rows } = await client.query<{ id: string; root_run_id: string }>(
      `insert into agent_runs (
         root_run_id, parent_run_id, parent_tool_call_id, depth, ancestor_agent_ids,
         user_id, agent_id, agent_version_id, conversation_id,
         status, queued_at, agent_version_snapshot
       ) values ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, 'queued', now(), $10::jsonb)
       returning ${childInsertColumns}`,
      [
        dispatch.root_run_id,
        dispatch.parent_run_id,
        dispatch.parent_tool_call_id,
        depth,
        ancestorAgentIds,
        dispatch.user_id,
        plan.agentId,
        plan.agentVersionId,
        raw.conversation_id,
        JSON.stringify(plan.agentVersionSnapshot),
      ],
    );
    const child = rows[0];
    if (!child) throw new Error('Agent subagent child Run was not created');
    await insertAgentWorkItem(client, {
      runId: child.id,
      rootRunId: child.root_run_id,
      userId: dispatch.user_id,
      parentWorkItemId: raw.parent_work_item_id,
      agentVersionId: plan.agentVersionId,
      kind: 'subagent',
      dispatchKey: dispatch.parent_tool_call_id,
      taskIndex: plan.taskIndex,
      payload: plan.workItemPayload,
    });
    createdChildCount += 1;
    return true;
  };

  const tasks = dispatch.plan.tasks;
  while (nextTaskIndex < tasks.length) {
    const task = tasks[nextTaskIndex];
    nextTaskIndex += 1;
    if (task.kind === 'failure') {
      immediate.push(task.outcome);
      continue;
    }
    await createChild(task);
    // Sequential dispatch advances only after the created child has reached a
    // terminal state and woken its parent. Immediate failures can be skipped in
    // the same transaction because there is nothing to wait for.
    if (dispatch.mode === 'sequential' && createdChildCount > dispatch.created_child_count) break;
  }

  const fullyMaterialized = nextTaskIndex >= tasks.length;
  const { rows } = await client.query<AgentSubagentDispatchRow>(
    `update agent_subagent_dispatches
     set status = $2,
         next_task_index = $3,
         created_child_count = $4,
         expected_child_count = $5,
         immediate_outcomes = $6::jsonb,
         materialized_at = $7,
         updated_at = now()
     where id = $1
     returning ${dispatchColumns}`,
    [
      dispatch.id,
      fullyMaterialized ? 'materialized' : 'materializing',
      nextTaskIndex,
      createdChildCount,
      fullyMaterialized ? createdChildCount : null,
      JSON.stringify(immediate),
      fullyMaterialized ? new Date().toISOString() : null,
    ],
  );
  return restoreDispatch(rows[0]);
});

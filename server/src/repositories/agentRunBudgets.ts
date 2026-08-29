import { createHash } from 'node:crypto';
import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';
import { activeRunStatusPredicate } from './agentRuns';

/**
 * Shared accounting for a Run tree.
 *
 * Every debit is a single conditional UPDATE rather than a read-then-write. That
 * matters as soon as more than one Run draws on the same ledger: two concurrently
 * dispatched subagents that each check the remaining balance before spending can
 * both pass the check and jointly overspend. Letting the database decide makes
 * the outcome of a race a rejected write instead of an overdraft.
 */

export interface AgentRunBudgetRow {
  root_run_id: string;
  user_id: string;
  deadline_at: string;
  token_total: number;
  token_consumed: number;
  token_reserved: number;
  iteration_total: number;
  iteration_consumed: number;
  tool_call_total: number;
  tool_call_consumed: number;
  subagent_dispatch_total: number;
  subagent_dispatch_consumed: number;
  final_answer_reserve_tokens: number;
  degraded_at?: string | null;
  degraded_reason?: string | null;
  created_at: string;
  updated_at: string;
}

const budgetColumns = `
  root_run_id,
  user_id,
  deadline_at,
  token_total,
  token_consumed,
  token_reserved,
  iteration_total,
  iteration_consumed,
  tool_call_total,
  tool_call_consumed,
  subagent_dispatch_total,
  subagent_dispatch_consumed,
  final_answer_reserve_tokens,
  degraded_at,
  degraded_reason,
  created_at,
  updated_at
`;

export const createAgentRunBudget = async (input: {
  rootRunId: string;
  userId: string;
  deadlineAt: Date;
  tokenTotal: number;
  iterationTotal: number;
  toolCallTotal: number;
  subagentDispatchTotal: number;
  finalAnswerReserveTokens: number;
}) => {
  // A retried Run start must not reset the allowance already spent, so the insert
  // is idempotent on the tree root.
  const { rows } = await query<AgentRunBudgetRow>(
    `insert into agent_run_budgets (
       root_run_id, user_id, deadline_at, token_total, iteration_total,
       tool_call_total, subagent_dispatch_total, final_answer_reserve_tokens
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (root_run_id) do nothing
     returning ${budgetColumns}`,
    [
      input.rootRunId,
      input.userId,
      input.deadlineAt.toISOString(),
      input.tokenTotal,
      input.iterationTotal,
      input.toolCallTotal,
      input.subagentDispatchTotal,
      input.finalAnswerReserveTokens,
    ],
  );
  if (rows[0]) return rows[0];
  return findAgentRunBudget(input.rootRunId);
};

export const findAgentRunBudget = async (rootRunId: string) => {
  const { rows } = await query<AgentRunBudgetRow>(
    `select ${budgetColumns} from agent_run_budgets where root_run_id = $1`,
    [rootRunId],
  );
  return rows[0] || null;
};

export type AgentBudgetDimension =
  | 'token'
  | 'iteration'
  | 'tool_call'
  | 'subagent_dispatch';

const dimensionColumns: Record<AgentBudgetDimension, { consumed: string; total: string }> = {
  token: { consumed: 'token_consumed', total: 'token_total' },
  iteration: { consumed: 'iteration_consumed', total: 'iteration_total' },
  tool_call: { consumed: 'tool_call_consumed', total: 'tool_call_total' },
  subagent_dispatch: {
    consumed: 'subagent_dispatch_consumed',
    total: 'subagent_dispatch_total',
  },
};

export interface AgentBudgetDebitResult {
  granted: boolean;
  budget: AgentRunBudgetRow | null;
  /** True when the request would fit only as the root's protected final turn. */
  reserveWouldCover: boolean;
}

export type AgentModelInvocationStatus = 'reserved' | 'succeeded' | 'failed' | 'indeterminate';
export type AgentModelUsageSource =
  | 'provider_reported'
  | 'tokenizer_estimated'
  | 'not_invoked'
  | 'reservation_conservative';

export interface AgentModelInvocationRow {
  id: string;
  run_id: string;
  root_run_id: string;
  reservation_tokens: number;
  actual_tokens: number | null;
  usage_source: AgentModelUsageSource | null;
  status: AgentModelInvocationStatus;
  exposure_started_at: string | null;
  result_format_version: 1 | null;
  result_payload: Record<string, unknown> | null;
  result_hash: string | null;
  created_at: string;
  completed_at: string | null;
}

const modelInvocationColumns = `
  id, run_id, root_run_id, reservation_tokens, actual_tokens,
  usage_source, status, exposure_started_at, result_format_version, result_payload, result_hash,
  created_at, completed_at
`;

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
};

export const prepareAgentModelInvocationResult = (payload: Record<string, unknown>) => {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new Error('Agent model result must be JSON serializable');
  }
  if (!serialized || serialized[0] !== '{') {
    throw new Error('Agent model result must be an object');
  }
  if (Buffer.byteLength(serialized, 'utf8') > Math.min(
    serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES,
    262_144,
  )) {
    throw new Error('Agent model result exceeds its durable payload limit');
  }
  const normalized = JSON.parse(serialized) as Record<string, unknown>;
  return {
    serialized,
    resultHash: createHash('sha256')
      .update(JSON.stringify(sortJsonValue(normalized)))
      .digest('hex'),
  };
};

export const restoreAgentModelInvocationResult = (row: AgentModelInvocationRow) => {
  if (
    row.status !== 'succeeded'
    || row.result_format_version !== 1
    || !row.result_payload
    || !row.result_hash
  ) return null;
  const prepared = prepareAgentModelInvocationResult(row.result_payload);
  if (prepared.resultHash !== row.result_hash) {
    throw new Error('Agent model result hash does not match its payload');
  }
  return structuredClone(row.result_payload);
};

export const findAgentModelInvocationForRun = async (input: {
  invocationId: string;
  runId: string;
}) => {
  const { rows } = await query<AgentModelInvocationRow>(
    `select ${modelInvocationColumns}
     from agent_model_invocations
     where id = $1 and run_id = $2`,
    [input.invocationId, input.runId],
  );
  return rows[0] || null;
};

/** Cross the provider-exposure boundary only while this Worker still owns the Work Item. */
export const markAgentModelInvocationExposure = async (input: {
  invocationId: string;
  runId: string;
  workItemId: string;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
}) => withTransaction(async (client) => {
  const { rows: ownerRows } = await client.query<{ id: string }>(
    `select work.id
     from agent_work_items work
     join agent_runs run on run.id = work.run_id
     where work.id = $1 and work.run_id = $2 and work.status = 'running'
       and work.lease_token = $3 and work.fencing_generation = $4
       and work.lease_expires_at > now()
       and ${activeRunStatusPredicate('run.status')}
     for update of work`,
    [
      input.workItemId,
      input.runId,
      input.workItemLeaseToken,
      input.workItemFencingGeneration,
    ],
  );
  if (!ownerRows[0]) return null;
  const { rows } = await client.query<AgentModelInvocationRow>(
    `update agent_model_invocations
     set exposure_started_at = coalesce(exposure_started_at, now())
     where id = $1 and run_id = $2 and status = 'reserved'
     returning ${modelInvocationColumns}`,
    [input.invocationId, input.runId],
  );
  return rows[0] || null;
});

/**
 * Release a reservation that provably never crossed the provider boundary.
 *
 * This is deliberately separate from the general settlement path: a Worker
 * that lost its Work Item lease must not be able to close an unexposed
 * reservation that a newer recovery Worker is about to execute.
 */
export const failUnexposedAgentModelInvocation = async (input: {
  invocationId: string;
  runId: string;
  workItemId: string;
  workItemLeaseToken: string;
  workItemFencingGeneration: number;
}) => withTransaction(async (client) => {
  const { rows: ownerRows } = await client.query<{ id: string }>(
    `select work.id
     from agent_work_items work
     join agent_runs run on run.id = work.run_id
     where work.id = $1 and work.run_id = $2 and work.status = 'running'
       and work.lease_token = $3 and work.fencing_generation = $4
       and work.lease_expires_at > now()
       and ${activeRunStatusPredicate('run.status')}
     for update of work`,
    [
      input.workItemId,
      input.runId,
      input.workItemLeaseToken,
      input.workItemFencingGeneration,
    ],
  );
  if (!ownerRows[0]) return null;
  const { rows: invocationRows } = await client.query<AgentModelInvocationRow>(
    `select ${modelInvocationColumns}
     from agent_model_invocations
     where id = $1 and run_id = $2 and status = 'reserved'
       and exposure_started_at is null
     for update`,
    [input.invocationId, input.runId],
  );
  const invocation = invocationRows[0];
  if (!invocation) return null;
  const { rows: budgetRows } = await client.query<AgentRunBudgetRow>(
    `update agent_run_budgets
     set token_reserved = token_reserved - $2, updated_at = now()
     where root_run_id = $1 and token_reserved >= $2
     returning ${budgetColumns}`,
    [invocation.root_run_id, invocation.reservation_tokens],
  );
  if (!budgetRows[0]) throw new Error('Agent model reservation could not be released');
  const { rows } = await client.query<AgentModelInvocationRow>(
    `update agent_model_invocations
     set status = 'failed', actual_tokens = 0, usage_source = 'not_invoked',
         completed_at = now()
     where id = $1 and run_id = $2 and status = 'reserved'
       and exposure_started_at is null
     returning ${modelInvocationColumns}`,
    [input.invocationId, input.runId],
  );
  if (!rows[0]) throw new Error('Agent model reservation changed while being released');
  return rows[0];
});

export type AgentModelReservationDenial =
  | 'budget_missing'
  | 'run_not_active'
  | 'final_answer_reserve_forbidden'
  | 'deadline_exceeded'
  | 'iteration_exhausted'
  | 'token_exhausted';

export type AgentModelReservationResult =
  | {
    granted: true;
    invocation: AgentModelInvocationRow;
    budget: AgentRunBudgetRow;
  }
  | {
    granted: false;
    reason: AgentModelReservationDenial;
    reserveWouldCover: boolean;
    budget: AgentRunBudgetRow | null;
  };

/**
 * Atomically reserve one model iteration and its maximum token exposure.
 * Parallel descendants contend on one conditional budget UPDATE, so only the
 * requests that fit are allowed to reach a provider.
 */
export const reserveAgentModelInvocation = async (input: {
  runId: string;
  rootRunId: string;
  reservationTokens: number;
  allowFinalAnswerReserve?: boolean;
}): Promise<AgentModelReservationResult> => {
  if (!Number.isInteger(input.reservationTokens) || input.reservationTokens <= 0) {
    throw new Error('Agent model reservation must be a positive integer');
  }
  return withTransaction(async (client) => {
    const reserveTerm = input.allowFinalAnswerReserve ? '' : ' - final_answer_reserve_tokens';
    // The final root answer needs a model turn as well as tokens. Descendants and
    // ordinary root work share every earlier iteration but can never consume the
    // last one.
    const iterationReserveTerm = input.allowFinalAnswerReserve ? '' : ' - 1';
    const rootOnlyTerm = input.allowFinalAnswerReserve
      ? ' and run.id = budget.root_run_id'
      : '';
    const { rows: budgetRows } = await client.query<AgentRunBudgetRow>(
      `update agent_run_budgets budget
       set token_reserved = token_reserved + $3,
           iteration_consumed = iteration_consumed + 1,
           updated_at = now()
       where root_run_id = $1
         and deadline_at > now()
         and iteration_consumed + 1 <= iteration_total${iterationReserveTerm}
         and token_consumed + token_reserved + $3 <= token_total${reserveTerm}
         and exists (
            select 1 from agent_runs run
            where run.id = $2 and run.root_run_id = budget.root_run_id
              and ${activeRunStatusPredicate('run.status')}
              ${rootOnlyTerm}
          )
       returning ${budgetColumns}`,
      [input.rootRunId, input.runId, input.reservationTokens],
    );
    const budget = budgetRows[0];
    if (!budget) {
      const { rows } = await client.query<AgentRunBudgetRow & {
        run_active: boolean;
        run_is_root: boolean;
      }>(
        `select ${budgetColumns},
                exists (
                  select 1 from agent_runs run
                  where run.id = $2 and run.root_run_id = budget.root_run_id
                    and ${activeRunStatusPredicate('run.status')}
                ) as run_active,
                exists (
                  select 1 from agent_runs run
                  where run.id = $2 and run.id = budget.root_run_id
                ) as run_is_root
         from agent_run_budgets budget
         where root_run_id = $1`,
        [input.rootRunId, input.runId],
      );
      const current = rows[0] || null;
      const now = Date.now();
      const ordinaryIterationCeiling = current
        ? current.iteration_total - (input.allowFinalAnswerReserve ? 0 : 1)
        : 0;
      const reason: AgentModelReservationDenial = !current
        ? 'budget_missing'
        : new Date(current.deadline_at).getTime() <= now
          ? 'deadline_exceeded'
          : !current.run_active
            ? 'run_not_active'
            : input.allowFinalAnswerReserve && !current.run_is_root
              ? 'final_answer_reserve_forbidden'
              : current.iteration_consumed + 1 > ordinaryIterationCeiling
                ? 'iteration_exhausted'
                : 'token_exhausted';
      return {
        granted: false,
        reason,
        reserveWouldCover: Boolean(
          current
          && !input.allowFinalAnswerReserve
          && current.run_active
          && current.iteration_consumed + 1 <= current.iteration_total
          && current.token_consumed + current.token_reserved + input.reservationTokens
            <= current.token_total,
        ),
        budget: current,
      };
    }
    const { rows: invocationRows } = await client.query<AgentModelInvocationRow>(
      `insert into agent_model_invocations (
         run_id, root_run_id, reservation_tokens
       ) values ($1, $2, $3)
       returning ${modelInvocationColumns}`,
      [input.runId, input.rootRunId, input.reservationTokens],
    );
    return { granted: true, invocation: invocationRows[0], budget };
  });
};

/** Move one reservation into consumed usage exactly once. */
export const settleAgentModelInvocation = async (input: {
  invocationId: string;
  runId: string;
  status: Exclude<AgentModelInvocationStatus, 'reserved'>;
  actualTokens: number;
  usageSource: AgentModelUsageSource;
  resultPayload?: Record<string, unknown>;
}) => {
  if (!Number.isInteger(input.actualTokens) || input.actualTokens < 0) {
    throw new Error('Agent model usage must be a non-negative integer');
  }
  if (input.status === 'succeeded' && !input.resultPayload) {
    throw new Error('A succeeded Agent model invocation requires a durable result');
  }
  if (
    input.status === 'succeeded'
    && !['provider_reported', 'tokenizer_estimated'].includes(input.usageSource)
  ) {
    throw new Error('A succeeded Agent model invocation requires measured usage');
  }
  if (input.status === 'failed' && input.usageSource !== 'not_invoked') {
    throw new Error('A failed Agent model invocation must not have reached the provider');
  }
  if (
    input.status === 'indeterminate'
    && input.usageSource !== 'reservation_conservative'
  ) {
    throw new Error('An indeterminate Agent model invocation requires conservative usage');
  }
  const result = input.status === 'succeeded'
    ? prepareAgentModelInvocationResult(input.resultPayload!)
    : null;
  if (input.status !== 'succeeded' && input.resultPayload !== undefined) {
    throw new Error('Only a succeeded Agent model invocation may store a result');
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query<AgentModelInvocationRow>(
      `select ${modelInvocationColumns}
       from agent_model_invocations
       where id = $1 and run_id = $2
       for update`,
      [input.invocationId, input.runId],
    );
    const invocation = rows[0];
    if (!invocation) return null;
    if (invocation.status !== 'reserved') return invocation;
    if (input.actualTokens > invocation.reservation_tokens) {
      throw new Error('Agent model usage exceeded its reservation');
    }
    const { rows: budgetRows } = await client.query<AgentRunBudgetRow>(
      `update agent_run_budgets
       set token_reserved = token_reserved - $2,
           token_consumed = token_consumed + $3,
           updated_at = now()
       where root_run_id = $1
         and token_reserved >= $2
         and token_consumed + token_reserved - $2 + $3 <= token_total
       returning ${budgetColumns}`,
      [invocation.root_run_id, invocation.reservation_tokens, input.actualTokens],
    );
    if (!budgetRows[0]) throw new Error('Agent model reservation could not be settled');
    const { rows: settledRows } = await client.query<AgentModelInvocationRow>(
      `update agent_model_invocations
       set status = $3, actual_tokens = $4, usage_source = $5,
           result_format_version = $6, result_payload = $7::jsonb, result_hash = $8,
           completed_at = now()
       where id = $1 and run_id = $2 and status = 'reserved'
       returning ${modelInvocationColumns}`,
      [
        input.invocationId,
        input.runId,
        input.status,
        input.actualTokens,
        input.usageSource,
        result ? 1 : null,
        result?.serialized ?? null,
        result?.resultHash ?? null,
      ],
    );
    return settledRows[0] || null;
  });
};

/**
 * Conservatively close reservations whose owner can no longer make progress.
 *
 * A process can die after the provider accepted a request but before settlement.
 * Releasing that reservation would risk spending the same tokens twice, so an
 * expired or terminal Run converts the entire exposure to indeterminate usage.
 * Active work keeps its reservation until either it settles or its tree deadline
 * passes.
 */
export const settleExpiredAgentModelInvocations = async (limit = 100) => {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error('Agent model invocation sweep limit must be between 1 and 1000');
  }
  const { rows } = await query<{ id: string }>(
    `with candidates as materialized (
       select invocation.id, invocation.root_run_id, invocation.reservation_tokens,
              invocation.exposure_started_at
       from agent_model_invocations invocation
       join agent_run_budgets budget on budget.root_run_id = invocation.root_run_id
       join agent_runs run on run.id = invocation.run_id
       where invocation.status = 'reserved'
         and (
           budget.deadline_at <= now()
           or not (${activeRunStatusPredicate('run.status')})
         )
       order by invocation.created_at
       for update of invocation skip locked
       limit $1
     ), totals as (
       select root_run_id,
              sum(reservation_tokens)::integer as reservation_tokens,
              sum(case when exposure_started_at is not null then reservation_tokens else 0 end)
                ::integer as exposed_tokens
       from candidates
       group by root_run_id
     ), charged_budgets as (
       update agent_run_budgets budget
       set token_reserved = budget.token_reserved - totals.reservation_tokens,
           token_consumed = budget.token_consumed + totals.exposed_tokens,
           updated_at = now()
       from totals
       where budget.root_run_id = totals.root_run_id
         and budget.token_reserved >= totals.reservation_tokens
       returning budget.root_run_id
     )
     update agent_model_invocations invocation
     set status = case
           when candidates.exposure_started_at is null then 'failed'
           else 'indeterminate'
         end,
         actual_tokens = case
           when candidates.exposure_started_at is null then 0
           else invocation.reservation_tokens
         end,
         usage_source = case
           when candidates.exposure_started_at is null then 'not_invoked'
           else 'reservation_conservative'
         end,
         completed_at = now()
     from candidates, charged_budgets
     where invocation.id = candidates.id
       and invocation.root_run_id = charged_budgets.root_run_id
       and invocation.status = 'reserved'
     returning invocation.id`,
    [limit],
  );
  return rows.map((row) => row.id);
};

/**
 * Charge `amount` against one dimension of the tree's allowance.
 *
 * Generic debits are always ordinary work and can never spend the protected final
 * model turn. Only `reserveAgentModelInvocation`, which proves the caller is the
 * active root Run, can cross that boundary.
 */
export const debitAgentRunBudget = async (input: {
  runId: string;
  rootRunId: string;
  dimension: AgentBudgetDimension;
  amount: number;
}): Promise<AgentBudgetDebitResult> => {
  if (!Number.isInteger(input.amount) || input.amount < 0) {
    throw new Error('Agent budget debit amount must be a non-negative integer');
  }
  const columns = dimensionColumns[input.dimension];
  // A usable final answer needs both tokens and one provider turn. Tool calls and
  // dispatches have no equivalent reserve.
  const reserveTerm = input.dimension === 'token'
    ? ' - final_answer_reserve_tokens'
    : input.dimension === 'iteration'
      ? ' - 1'
    : '';
  const exposureTerm = input.dimension === 'token'
    ? `${columns.consumed} + token_reserved + $2`
    : `${columns.consumed} + $2`;
  const { rows } = await query<AgentRunBudgetRow>(
    `update agent_run_budgets
     set ${columns.consumed} = ${columns.consumed} + $2, updated_at = now()
     where root_run_id = $1
       and deadline_at > now()
       and ${exposureTerm} <= ${columns.total}${reserveTerm}
       and exists (
         select 1 from agent_runs run
         where run.id = $3 and run.root_run_id = agent_run_budgets.root_run_id
           and ${activeRunStatusPredicate('run.status')}
       )
     returning ${budgetColumns}`,
    [input.rootRunId, input.amount, input.runId],
  );
  if (rows[0]) return { granted: true, budget: rows[0], reserveWouldCover: false };

  const { rows: currentRows } = await query<AgentRunBudgetRow & { run_active: boolean }>(
    `select ${budgetColumns},
            exists (
              select 1 from agent_runs run
              where run.id = $2 and run.root_run_id = budget.root_run_id
                and ${activeRunStatusPredicate('run.status')}
            ) as run_active
     from agent_run_budgets budget
     where root_run_id = $1`,
    [input.rootRunId, input.runId],
  );
  const current = currentRows[0] || null;
  const reserveWouldCover = Boolean(
    current
    && new Date(current.deadline_at).getTime() > Date.now()
    && current.run_active
    && (
      input.dimension === 'token'
        ? current.token_consumed + current.token_reserved + input.amount <= current.token_total
        : input.dimension === 'iteration'
          && current.iteration_consumed + input.amount <= current.iteration_total
    ),
  );
  return { granted: false, budget: current, reserveWouldCover };
};

/**
 * Charge the shared tree allowance exactly once for one logical tool call.
 *
 * The marker and counter update share a transaction. A recovery worker can
 * therefore retry this function after any crash point: an existing marker
 * proves the debit committed, while a missing marker means no debit survived.
 */
export const debitAgentToolCallBudget = async (input: {
  runId: string;
  rootRunId: string;
  toolCallId: string;
}): Promise<AgentBudgetDebitResult & { alreadyDebited: boolean }> => withTransaction(
  async (client) => {
    if (!input.toolCallId || input.toolCallId.length > 512) {
      throw new Error('Agent tool call budget identity is invalid');
    }
    const { rows: markerRows } = await client.query<{ run_id: string }>(
      `insert into agent_tool_budget_debits (run_id, root_run_id, tool_call_id)
       select run.id, run.root_run_id, $3
       from agent_runs run
       where run.id = $1 and run.root_run_id = $2
         and ${activeRunStatusPredicate('run.status')}
       on conflict (run_id, tool_call_id) do nothing
       returning run_id`,
      [input.runId, input.rootRunId, input.toolCallId],
    );
    if (!markerRows[0]) {
      const { rows } = await client.query<AgentRunBudgetRow>(
        `select ${budgetColumns}
         from agent_run_budgets
         where root_run_id = $1
           and exists (
             select 1
             from agent_tool_budget_debits debit
             where debit.run_id = $2
               and debit.root_run_id = agent_run_budgets.root_run_id
               and debit.tool_call_id = $3
           )`,
        [input.rootRunId, input.runId, input.toolCallId],
      );
      return {
        granted: Boolean(rows[0]),
        budget: rows[0] || null,
        reserveWouldCover: false,
        alreadyDebited: Boolean(rows[0]),
      };
    }

    const { rows: budgetRows } = await client.query<AgentRunBudgetRow>(
      `update agent_run_budgets budget
       set tool_call_consumed = tool_call_consumed + 1, updated_at = now()
       where budget.root_run_id = $1
         and budget.deadline_at > now()
         and budget.tool_call_consumed + 1 <= budget.tool_call_total
         and exists (
           select 1 from agent_runs run
           where run.id = $2 and run.root_run_id = budget.root_run_id
             and ${activeRunStatusPredicate('run.status')}
         )
       returning ${budgetColumns}`,
      [input.rootRunId, input.runId],
    );
    if (budgetRows[0]) {
      return {
        granted: true,
        budget: budgetRows[0],
        reserveWouldCover: false,
        alreadyDebited: false,
      };
    }

    // A denied debit must leave no marker; otherwise a later recovery attempt
    // could mistake a rejected call for a committed charge.
    await client.query(
      `delete from agent_tool_budget_debits
       where run_id = $1 and root_run_id = $2 and tool_call_id = $3`,
      [input.runId, input.rootRunId, input.toolCallId],
    );
    const { rows: currentRows } = await client.query<AgentRunBudgetRow>(
      `select ${budgetColumns} from agent_run_budgets where root_run_id = $1`,
      [input.rootRunId],
    );
    return {
      granted: false,
      budget: currentRows[0] || null,
      reserveWouldCover: false,
      alreadyDebited: false,
    };
  },
);

/**
 * Record that the tree crossed into its reserve and lost access to tools. The
 * write is conditional so the first transition wins and concurrent runs in the
 * same tree do not overwrite each other's reason.
 */
export const markAgentRunBudgetDegraded = async (
  rootRunId: string,
  reason: string,
) => {
  const { rows } = await query<AgentRunBudgetRow>(
    `update agent_run_budgets
     set degraded_at = now(), degraded_reason = $2, updated_at = now()
     where root_run_id = $1 and degraded_at is null
     returning ${budgetColumns}`,
    [rootRunId, reason],
  );
  return rows[0] || null;
};

export const remainingAgentRunBudget = (
  budget: AgentRunBudgetRow,
  dimension: AgentBudgetDimension,
  options: { allowReserve?: boolean } = {},
) => {
  const columns = dimensionColumns[dimension];
  const total = Number(budget[columns.total as keyof AgentRunBudgetRow]);
  const consumed = Number(budget[columns.consumed as keyof AgentRunBudgetRow]);
  const reserve = dimension === 'token' && !options.allowReserve
    ? budget.final_answer_reserve_tokens
    : dimension === 'iteration' && !options.allowReserve
      ? 1
      : 0;
  const reserved = dimension === 'token' ? budget.token_reserved : 0;
  return Math.max(0, total - reserve - consumed - reserved);
};

import { query } from '../lib/db';

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
  /** True when the request would fit only by spending the final-answer reserve. */
  reserveWouldCover: boolean;
}

/**
 * Charge `amount` against one dimension of the tree's allowance.
 *
 * `allowReserve` distinguishes ordinary work from the one turn that is allowed to
 * spend the reserve. Ordinary work is capped below the reserve so that a Run
 * always retains enough allowance to say something useful instead of failing with
 * nothing to show.
 */
export const debitAgentRunBudget = async (input: {
  rootRunId: string;
  dimension: AgentBudgetDimension;
  amount: number;
  allowReserve?: boolean;
}): Promise<AgentBudgetDebitResult> => {
  if (!Number.isInteger(input.amount) || input.amount < 0) {
    throw new Error('Agent budget debit amount must be a non-negative integer');
  }
  const columns = dimensionColumns[input.dimension];
  // The reserve only guards tokens. Iterations, tool calls and dispatches have no
  // meaningful "partial answer" equivalent to protect.
  const reserveTerm = input.dimension === 'token' && !input.allowReserve
    ? ' - final_answer_reserve_tokens'
    : '';
  const { rows } = await query<AgentRunBudgetRow>(
    `update agent_run_budgets
     set ${columns.consumed} = ${columns.consumed} + $2, updated_at = now()
     where root_run_id = $1
       and ${columns.consumed} + $2 <= ${columns.total}${reserveTerm}
     returning ${budgetColumns}`,
    [input.rootRunId, input.amount],
  );
  if (rows[0]) return { granted: true, budget: rows[0], reserveWouldCover: false };

  const current = await findAgentRunBudget(input.rootRunId);
  const reserveWouldCover = Boolean(
    current
    && input.dimension === 'token'
    && !input.allowReserve
    && current.token_consumed + input.amount <= current.token_total,
  );
  return { granted: false, budget: current, reserveWouldCover };
};

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
    : 0;
  return Math.max(0, total - reserve - consumed);
};

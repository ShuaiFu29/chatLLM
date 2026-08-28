-- A budget that is shared across a Run tree instead of re-initialised per Run.
--
-- Iteration, duration and token limits are Agent *version* configuration. As
-- long as a Run was always a lone node that was fine, but a dispatched subagent
-- reading its own configuration would start a fresh allowance: nesting two levels
-- with a fan-out of three multiplies the worst-case spend instead of dividing it.
--
-- The ledger makes the allowance a property of the tree. Children draw from it,
-- they never mint more. The deadline is absolute and set once by the root, so a
-- child cannot outlive its parent by having a longer configured duration.
create table if not exists agent_run_budgets (
  root_run_id uuid primary key references agent_runs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  -- Absolute, never extended. A duration would be re-interpreted by every
  -- descendant; an instant cannot be.
  deadline_at timestamptz not null,
  token_total integer not null,
  token_consumed integer not null default 0,
  iteration_total integer not null,
  iteration_consumed integer not null default 0,
  tool_call_total integer not null,
  tool_call_consumed integer not null default 0,
  subagent_dispatch_total integer not null default 0,
  subagent_dispatch_consumed integer not null default 0,
  -- Tokens that only a final, tool-free turn may spend. Without a reserve, a Run
  -- that exhausts its budget fails and the user gets nothing, even though the
  -- model already held enough information to answer partially. Fan-out makes
  -- exhaustion the common case rather than an edge case.
  final_answer_reserve_tokens integer not null,
  -- Set when the Run crossed into the reserve and tools were withdrawn, so a
  -- partial answer is auditable rather than looking like a complete one.
  degraded_at timestamptz,
  degraded_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_run_budgets_token_total_check check (token_total > 0),
  constraint agent_run_budgets_iteration_total_check check (iteration_total > 0),
  constraint agent_run_budgets_tool_call_total_check check (tool_call_total >= 0),
  constraint agent_run_budgets_subagent_total_check check (subagent_dispatch_total >= 0),
  -- Consumption can never exceed the allowance. Enforcing it here means an
  -- accounting bug surfaces as a failed write rather than as silent overspend.
  constraint agent_run_budgets_token_consumed_check
    check (token_consumed >= 0 and token_consumed <= token_total),
  constraint agent_run_budgets_iteration_consumed_check
    check (iteration_consumed >= 0 and iteration_consumed <= iteration_total),
  constraint agent_run_budgets_tool_call_consumed_check
    check (tool_call_consumed >= 0 and tool_call_consumed <= tool_call_total),
  constraint agent_run_budgets_subagent_consumed_check
    check (subagent_dispatch_consumed >= 0
      and subagent_dispatch_consumed <= subagent_dispatch_total),
  -- The reserve has to leave room for ordinary work as well.
  constraint agent_run_budgets_reserve_check
    check (final_answer_reserve_tokens >= 0 and final_answer_reserve_tokens < token_total),
  constraint agent_run_budgets_degraded_check
    check ((degraded_at is null and degraded_reason is null)
      or (degraded_at is not null and degraded_reason is not null))
);

create index if not exists agent_run_budgets_user_idx
  on agent_run_budgets (user_id, created_at desc);
-- Supports sweeping trees whose absolute deadline has passed.
create index if not exists agent_run_budgets_deadline_idx
  on agent_run_budgets (deadline_at)
  where degraded_at is null;

-- Tool executions are retried only when the runtime can prove a retry will not
-- duplicate a side effect. The key is derived from the Run and the tool call, so
-- the same logical call keeps one identity across attempts, and a tool that
-- honours it can be retried safely after a transport failure.
create table if not exists agent_tool_invocations (
  idempotency_key text primary key,
  run_id uuid not null references agent_runs(id) on delete cascade,
  tool_call_id text not null,
  tool_key text not null,
  attempt_count smallint not null default 1,
  status text not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_tool_invocations_status_check
    check (status in ('in_flight', 'succeeded', 'failed')),
  constraint agent_tool_invocations_attempt_check
    check (attempt_count >= 1 and attempt_count <= 10),
  constraint agent_tool_invocations_unique_call unique (run_id, tool_call_id)
);

create index if not exists agent_tool_invocations_run_idx
  on agent_tool_invocations (run_id, created_at);

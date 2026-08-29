-- A tool call may be checkpointed before its invocation ledger exists. If a
-- worker dies after debiting the tree budget but before beginning the tool
-- invocation, recovery must not debit the same logical call again.
create table if not exists agent_tool_budget_debits (
  run_id uuid not null,
  root_run_id uuid not null,
  tool_call_id text not null,
  created_at timestamptz not null default now(),
  primary key (run_id, tool_call_id),
  constraint agent_tool_budget_debits_run_tree_fk
    foreign key (run_id, root_run_id)
    references agent_runs(id, root_run_id) on delete cascade,
  constraint agent_tool_budget_debits_call_id_check
    check (length(tool_call_id) between 1 and 512)
);

create index if not exists agent_tool_budget_debits_root_created_idx
  on agent_tool_budget_debits(root_run_id, created_at);

comment on table agent_tool_budget_debits is
  'Exactly-once tree-budget charge keyed by one durable model tool_call id.';

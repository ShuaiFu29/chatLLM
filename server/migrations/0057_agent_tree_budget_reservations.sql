-- A conditional debit after a model response is too late: parallel descendants
-- may all pass a local pre-check and jointly overspend before any one of them
-- reports usage. Reserve the worst-case request cost before contacting a model,
-- then settle the actual usage and release the difference.
alter table agent_run_budgets
  add column if not exists token_reserved integer not null default 0;

alter table agent_run_budgets
  drop constraint if exists agent_run_budgets_token_consumed_check;

alter table agent_run_budgets
  add constraint agent_run_budgets_token_accounting_check
  check (
    token_consumed >= 0
    and token_reserved >= 0
    and token_consumed + token_reserved <= token_total
  );

-- Lets the invocation foreign key prove that its run and root belong to the same
-- tree. Independent foreign keys would accept a run from tree A paired with the
-- budget of tree B.
create unique index if not exists agent_runs_id_root_unique_idx
  on agent_runs(id, root_run_id);

create table if not exists agent_model_invocations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  root_run_id uuid not null references agent_run_budgets(root_run_id) on delete cascade,
  reservation_tokens integer not null,
  actual_tokens integer,
  usage_source text,
  status text not null default 'reserved',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint agent_model_invocations_run_tree_fk
    foreign key (run_id, root_run_id)
    references agent_runs(id, root_run_id) on delete cascade,
  constraint agent_model_invocations_reservation_check
    check (reservation_tokens > 0),
  constraint agent_model_invocations_status_check
    check (status in ('reserved', 'succeeded', 'failed', 'indeterminate')),
  constraint agent_model_invocations_usage_source_check
    check (usage_source is null or usage_source in (
      'provider_reported', 'tokenizer_estimated', 'reservation_conservative'
    )),
  constraint agent_model_invocations_terminal_check check (
    (status = 'reserved' and actual_tokens is null and usage_source is null and completed_at is null)
    or (
      status in ('succeeded', 'failed', 'indeterminate')
      and actual_tokens is not null
      and actual_tokens >= 0
      and actual_tokens <= reservation_tokens
      and usage_source is not null
      and completed_at is not null
    )
  )
);

create index if not exists agent_model_invocations_root_created_idx
  on agent_model_invocations(root_run_id, created_at);

create index if not exists agent_model_invocations_reserved_idx
  on agent_model_invocations(created_at)
  where status = 'reserved';

comment on table agent_model_invocations is
  'Durable preflight and settlement ledger for every model turn in one Agent Run tree.';

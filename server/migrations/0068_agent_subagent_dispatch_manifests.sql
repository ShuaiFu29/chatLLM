-- A subagent fan-out is a durable operation of its own. The parent checkpoint
-- may be committed before any child exists, so the exact prepared child batch
-- must survive independently of the worker that prepared it.
create table if not exists agent_subagent_dispatches (
  id uuid primary key default gen_random_uuid(),
  parent_run_id uuid not null,
  root_run_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  parent_tool_call_id text not null,
  mode text not null,
  format_version smallint not null default 1,
  plan jsonb not null,
  plan_hash text not null,
  status text not null default 'planned',
  next_task_index smallint not null default 0,
  created_child_count smallint not null default 0,
  expected_child_count smallint,
  immediate_outcomes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  materialized_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint agent_subagent_dispatches_parent_tree_fk
    foreign key (parent_run_id, root_run_id)
    references agent_runs(id, root_run_id) on delete cascade,
  constraint agent_subagent_dispatches_identity_unique
    unique (parent_run_id, parent_tool_call_id),
  constraint agent_subagent_dispatches_tool_call_check
    check (parent_tool_call_id <> ''),
  constraint agent_subagent_dispatches_mode_check
    check (mode in ('parallel', 'sequential')),
  constraint agent_subagent_dispatches_format_check
    check (format_version = 1),
  constraint agent_subagent_dispatches_plan_object_check
    check (jsonb_typeof(plan) = 'object'),
  constraint agent_subagent_dispatches_plan_size_check
    check (octet_length(plan::text) <= 262144),
  constraint agent_subagent_dispatches_plan_hash_check
    check (plan_hash ~ '^[0-9a-f]{64}$'),
  constraint agent_subagent_dispatches_status_check
    check (status in ('planned', 'materializing', 'materialized')),
  constraint agent_subagent_dispatches_cursor_check
    check (
      next_task_index >= 0
      and next_task_index <= jsonb_array_length(plan->'tasks')
      and created_child_count >= 0
      and created_child_count <= next_task_index
    ),
  constraint agent_subagent_dispatches_child_count_check
    check (expected_child_count is null or expected_child_count >= 0),
  constraint agent_subagent_dispatches_outcomes_array_check
    check (jsonb_typeof(immediate_outcomes) = 'array'),
  constraint agent_subagent_dispatches_materialization_check
    check (
      (status in ('planned', 'materializing') and expected_child_count is null and materialized_at is null)
      or
      (
        status = 'materialized'
        and expected_child_count = created_child_count
        and materialized_at is not null
      )
    )
);

create index if not exists agent_subagent_dispatches_root_idx
  on agent_subagent_dispatches(root_run_id, created_at);

comment on table agent_subagent_dispatches is
  'Immutable prepared fan-out manifests used to materialize child Agent Runs exactly once across worker crashes.';

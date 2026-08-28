-- Turn an Agent Run from a flat row into a node in a run tree, and give every
-- step a span identity.
--
-- Motivation: subagent orchestration, shared budget accounting, strictest-
-- ancestor permission resolution, cascade cancellation and end-to-end tracing
-- all need the same missing thing -- a Run that knows its lineage. Adding them
-- separately would grow four incompatible ad-hoc mechanisms.
--
-- This migration is deliberately behaviour-neutral: every existing Run becomes a
-- root of its own tree (depth 0, root_run_id = id, no parent), which is exactly
-- what it already was implicitly.

alter table agent_runs
  add column if not exists root_run_id uuid;
alter table agent_runs
  add column if not exists parent_run_id uuid;
alter table agent_runs
  add column if not exists parent_tool_call_id text;
alter table agent_runs
  add column if not exists depth smallint not null default 0;
-- Carries every agent_id on the path from the root to this Run. Runtime cycle
-- detection tests membership here: a static check at publish time cannot be
-- sufficient, because binding B into A is legal until B is later published with
-- a binding back to A.
alter table agent_runs
  add column if not exists ancestor_agent_ids uuid[] not null default '{}'::uuid[];

-- Existing rows are roots.
update agent_runs set root_run_id = id where root_run_id is null;

alter table agent_runs
  alter column root_run_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_runs_parent_fk' and conrelid = 'agent_runs'::regclass
  ) then
    alter table agent_runs
      add constraint agent_runs_parent_fk
      foreign key (parent_run_id) references agent_runs(id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_runs_root_fk' and conrelid = 'agent_runs'::regclass
  ) then
    alter table agent_runs
      add constraint agent_runs_root_fk
      foreign key (root_run_id) references agent_runs(id) on delete cascade;
  end if;
end $$;

-- A Run is either a root or a descendant; the three lineage columns cannot
-- disagree about which.
alter table agent_runs
  drop constraint if exists agent_runs_lineage_check;
alter table agent_runs
  add constraint agent_runs_lineage_check
  check (
    (parent_run_id is null and depth = 0 and root_run_id = id)
    or (parent_run_id is not null and depth > 0 and root_run_id <> id)
  );

-- Depth is bounded in the schema as well as in the runtime. Unbounded nesting
-- multiplies cost and makes a Run tree impossible to reason about; three levels
-- is enough for "orchestrator -> worker -> helper".
alter table agent_runs
  drop constraint if exists agent_runs_depth_check;
alter table agent_runs
  add constraint agent_runs_depth_check
  check (depth >= 0 and depth <= 3);

-- One ancestor agent per level above this Run. Keeping the invariant checkable
-- means a cycle-detection bug shows up as a constraint violation rather than as
-- a silently unbounded recursion.
alter table agent_runs
  drop constraint if exists agent_runs_ancestor_cardinality_check;
alter table agent_runs
  add constraint agent_runs_ancestor_cardinality_check
  check (cardinality(ancestor_agent_ids) = depth);

-- A parent that is blocked on its children needs a state of its own: the flat
-- six-state machine could not express "I am waiting on a child, which is itself
-- waiting for a human approval".
alter table agent_runs
  drop constraint if exists agent_runs_status_check;
alter table agent_runs
  add constraint agent_runs_status_check
  check (status in (
    'queued', 'running', 'waiting_approval', 'waiting_subagent',
    'succeeded', 'failed', 'cancelled'
  ));

create index if not exists agent_runs_root_idx
  on agent_runs (root_run_id, created_at);
create index if not exists agent_runs_parent_idx
  on agent_runs (parent_run_id)
  where parent_run_id is not null;
-- Supports the per-user active-run quota, which counts root Runs only: a fan-out
-- of subagents must not exhaust the quota that exists to bound concurrent
-- user-visible work.
create index if not exists agent_runs_user_active_root_idx
  on agent_runs (user_id, status)
  where parent_run_id is null;

alter table agent_steps
  add column if not exists trace_id uuid;
alter table agent_steps
  add column if not exists span_id uuid not null default gen_random_uuid();
alter table agent_steps
  add column if not exists parent_span_id uuid;

-- Backfill: the trace of an existing step is its Run's tree root.
update agent_steps
set trace_id = agent_runs.root_run_id
from agent_runs
where agent_steps.run_id = agent_runs.id
  and agent_steps.trace_id is null;

alter table agent_steps
  alter column trace_id set not null;

-- Decisions that were previously invisible get first-class step kinds. Without
-- them, a Run's step log records what the model asked for but not what the
-- runtime decided: which memories were read, what history was evicted to fit the
-- context, why a budget check failed, or how a task was decomposed.
alter table agent_steps
  drop constraint if exists agent_steps_kind_check;
alter table agent_steps
  add constraint agent_steps_kind_check
  check (kind in (
    'model', 'tool_call', 'tool_result', 'approval', 'assistant',
    'plan', 'memory_read', 'memory_write', 'context_evicted',
    'budget_check', 'subagent_dispatch', 'subagent_result'
  ));

alter table agent_steps
  drop constraint if exists agent_steps_span_distinct_check;
alter table agent_steps
  add constraint agent_steps_span_distinct_check
  check (parent_span_id is null or parent_span_id <> span_id);

create unique index if not exists agent_steps_span_unique
  on agent_steps (span_id);
create index if not exists agent_steps_trace_idx
  on agent_steps (trace_id, created_at);
create index if not exists agent_steps_parent_span_idx
  on agent_steps (parent_span_id)
  where parent_span_id is not null;

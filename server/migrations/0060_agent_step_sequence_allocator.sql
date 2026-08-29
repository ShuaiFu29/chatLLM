-- Step ordering must survive process loss and worker takeover. A process-local
-- `sequence++` restarts at zero and either collides with durable history or lets
-- a stale worker append new audit records after losing its Work Item claim.
alter table agent_runs
  add column if not exists next_step_sequence bigint not null default 0;

-- Existing Runs may already have timeline entries. Make the allocator start
-- after the durable maximum without renumbering history.
update agent_runs run
set next_step_sequence = greatest(
  run.next_step_sequence,
  coalesce((
    select max(step.sequence)::bigint + 1
    from agent_steps step
    where step.run_id = run.id
  ), 0)
);

alter table agent_runs
  drop constraint if exists agent_runs_next_step_sequence_check;

alter table agent_runs
  add constraint agent_runs_next_step_sequence_check
  check (next_step_sequence >= 0);

comment on column agent_runs.next_step_sequence is
  'Next durable Agent Step sequence. Allocations are fenced by the current agent_work_items execution claim.';

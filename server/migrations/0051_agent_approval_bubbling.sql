-- Let a dispatched subagent ask for human approval.
--
-- A subagent had no approval surface: anything the resolved policy sent to a human
-- was refused outright. That kept the guarantee intact -- a child could never
-- perform a write an ancestor required approval for -- but it also meant a task
-- needing an approved write simply could not be delegated.
--
-- The approval row is created on the *root* run rather than on the child, because
-- that is where the person is looking: the chat stream, the approval API and the
-- timeline are all anchored to the root. Recording which run actually needs the
-- decision keeps the request explainable without moving the decision point.
alter table agent_approvals
  add column if not exists requested_by_run_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_approvals_requested_by_fk'
      and conrelid = 'agent_approvals'::regclass
  ) then
    alter table agent_approvals
      add constraint agent_approvals_requested_by_fk
      foreign key (requested_by_run_id) references agent_runs(id) on delete cascade;
  end if;
end $$;

comment on column agent_approvals.requested_by_run_id is
  'The run that needs this decision. NULL means the run named by run_id asked for itself; a different value means a dispatched subagent asked and the decision is surfaced on the tree root.';

-- Listing the approvals a given subagent is blocked on.
create index if not exists agent_approvals_requested_by_idx
  on agent_approvals (requested_by_run_id)
  where requested_by_run_id is not null;

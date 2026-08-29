-- A claimed subagent remains owned by the same worker while it waits for its
-- own children. `waiting_subagent` is therefore an executing state for a
-- delegated Run, even though a root Run in that state has no worker lease.

-- Older deployments cleared leases from every non-running row. A delegated
-- waiter without a lease cannot safely be resumed, so close that abandoned
-- subtree instead of inventing new ownership during the upgrade.
with recursive orphaned_waiters as (
  select id
  from agent_runs
  where parent_run_id is not null
    and status = 'waiting_subagent'
    and lease_token is null
), orphaned_subtree as (
  select id from orphaned_waiters
  union all
  select child.id
  from agent_runs child
  join orphaned_subtree parent on child.parent_run_id = parent.id
)
update agent_approvals
set status = 'expired',
    decided_at = now(),
    reason = 'Subagent worker ownership was lost during upgrade'
where status = 'pending'
  and (
    run_id in (select id from orphaned_subtree)
    or requested_by_run_id in (select id from orphaned_subtree)
  );

with recursive orphaned_waiters as (
  select id
  from agent_runs
  where parent_run_id is not null
    and status = 'waiting_subagent'
    and lease_token is null
), orphaned_subtree as (
  select id from orphaned_waiters
  union all
  select child.id
  from agent_runs child
  join orphaned_subtree parent on child.parent_run_id = parent.id
)
update agent_steps
set status = 'failed',
    output = coalesce(output, '{}'::jsonb)
      || jsonb_build_object('reason', 'Subagent worker ownership was lost during upgrade')
where status in ('pending', 'running')
  and run_id in (select id from orphaned_subtree);

with recursive orphaned_waiters as (
  select id
  from agent_runs
  where parent_run_id is not null
    and status = 'waiting_subagent'
    and lease_token is null
), orphaned_subtree as (
  select id, true as ownership_lost from orphaned_waiters
  union all
  select child.id, false
  from agent_runs child
  join orphaned_subtree parent on child.parent_run_id = parent.id
)
update agent_runs run
set status = case
      when run.id in (select id from orphaned_waiters) then 'failed'
      else 'cancelled'
    end,
    completed_at = now(),
    error_code = case
      when run.id in (select id from orphaned_waiters) then 'subagent_lease_lost'
      else 'agent_run_parent_ended'
    end,
    error_message = case
      when run.id in (select id from orphaned_waiters)
        then 'Subagent worker ownership was lost during upgrade'
      else 'Parent Agent run ownership was lost during upgrade'
    end,
    lease_token = null,
    lease_expires_at = null
where run.id in (select id from orphaned_subtree)
  and run.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent');

alter table agent_runs
  drop constraint if exists agent_runs_lease_requires_running_check;

alter table agent_runs
  add constraint agent_runs_lease_requires_running_check
  check (
    (parent_run_id is null and lease_token is null)
    or (
      parent_run_id is not null
      and (
        (status in ('running', 'waiting_subagent') and lease_token is not null)
        or (status not in ('running', 'waiting_subagent') and lease_token is null)
      )
    )
  );

comment on constraint agent_runs_lease_requires_running_check on agent_runs is
  'A dispatched Run keeps its worker lease while running or waiting for descendants; roots and all other states carry no lease.';

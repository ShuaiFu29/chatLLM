-- A lease is an execution right, so it may exist only while a dispatched Run is
-- actively running. Earlier code released leases in a `finally` block after the
-- status update; a crash between those statements could leave a terminal row
-- carrying a lease, while an early return could leave a running row without one.
-- Runtime transitions now clear the lease atomically with the terminal status,
-- and this constraint makes future regressions fail at the write boundary.

-- Repair the early-return state produced by the old executor before making it
-- unrepresentable: a running child without a lease has no worker that can safely
-- submit its result.
update agent_approvals
set status = 'expired',
    decided_at = now(),
    reason = 'Subagent worker ownership was lost during upgrade'
where status = 'pending'
  and (
    run_id in (
      select id from agent_runs
      where parent_run_id is not null and status = 'running' and lease_token is null
    )
    or requested_by_run_id in (
      select id from agent_runs
      where parent_run_id is not null and status = 'running' and lease_token is null
    )
  );

update agent_steps
set status = 'failed',
    output = coalesce(output, '{}'::jsonb)
      || jsonb_build_object('reason', 'Subagent worker ownership was lost during upgrade')
where status in ('pending', 'running')
  and run_id in (
    select id from agent_runs
    where parent_run_id is not null and status = 'running' and lease_token is null
  );

update agent_runs
set status = 'failed',
    completed_at = now(),
    error_code = 'subagent_lease_lost',
    error_message = 'Subagent worker ownership was lost during upgrade'
where parent_run_id is not null and status = 'running' and lease_token is null;

update agent_runs
set lease_token = null, lease_expires_at = null
where status <> 'running'
  and (lease_token is not null or lease_expires_at is not null);

-- Repair trees left in the impossible state "a terminal parent still owns an
-- active descendant" before installing the deferred cross-row invariant.
with recursive invalid_descendants as (
  select child.id
  from agent_runs child
  join agent_runs parent on parent.id = child.parent_run_id
  where parent.status in ('succeeded', 'failed', 'cancelled')
    and child.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
  union
  select child.id
  from agent_runs child
  join invalid_descendants parent on child.parent_run_id = parent.id
  where child.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
)
update agent_approvals
set status = 'expired', decided_at = now(),
    reason = 'Parent Agent run had already ended during upgrade'
where status = 'pending'
  and (
    run_id in (select id from invalid_descendants)
    or requested_by_run_id in (select id from invalid_descendants)
  );

with recursive invalid_descendants as (
  select child.id
  from agent_runs child
  join agent_runs parent on parent.id = child.parent_run_id
  where parent.status in ('succeeded', 'failed', 'cancelled')
    and child.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
  union
  select child.id
  from agent_runs child
  join invalid_descendants parent on child.parent_run_id = parent.id
  where child.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
)
update agent_steps
set status = 'cancelled',
    output = coalesce(output, '{}'::jsonb)
      || jsonb_build_object('reason', 'Parent Agent run had already ended during upgrade')
where status in ('pending', 'running')
  and run_id in (select id from invalid_descendants);

with recursive invalid_descendants as (
  select child.id
  from agent_runs child
  join agent_runs parent on parent.id = child.parent_run_id
  where parent.status in ('succeeded', 'failed', 'cancelled')
    and child.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
  union
  select child.id
  from agent_runs child
  join invalid_descendants parent on child.parent_run_id = parent.id
  where child.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
)
update agent_runs
set status = 'cancelled', completed_at = now(),
    error_code = 'agent_run_parent_ended',
    error_message = 'Parent Agent run had already ended during upgrade',
    lease_token = null, lease_expires_at = null
where id in (select id from invalid_descendants);

alter table agent_runs
  drop constraint if exists agent_runs_lease_requires_running_check;
alter table agent_runs
  add constraint agent_runs_lease_requires_running_check
  check (
    (parent_run_id is null and lease_token is null)
    or (
      parent_run_id is not null
      and (
        (status = 'running' and lease_token is not null)
        or (status <> 'running' and lease_token is null)
      )
    )
  );

comment on constraint agent_runs_lease_requires_running_check on agent_runs is
  'A worker lease is valid only for an actively running dispatched Run; terminalization clears it in the same transaction.';

create or replace function enforce_agent_run_terminal_tree_integrity()
returns trigger
language plpgsql
as $$
declare
  current_status text;
begin
  -- Constraint triggers are deferred. Read the row's final value instead of
  -- the event's NEW value because one transaction may legitimately move it
  -- through several states before commit.
  select status into current_status from agent_runs where id = new.id;
  if not found then return null; end if;

  if current_status in ('queued', 'running', 'waiting_approval', 'waiting_subagent') then
    if exists (
      with recursive ancestors as (
        select parent.id, parent.parent_run_id, parent.status
        from agent_runs child
        join agent_runs parent on parent.id = child.parent_run_id
        where child.id = new.id
        union all
        select parent.id, parent.parent_run_id, parent.status
        from agent_runs parent
        join ancestors child on parent.id = child.parent_run_id
      )
      select 1 from ancestors
      where status in ('succeeded', 'failed', 'cancelled')
    ) then
      raise exception using
        errcode = '23514',
        constraint = 'agent_runs_terminal_tree_integrity',
        message = 'An active Agent run cannot have a terminal ancestor';
    end if;
  else
    if exists (
      with recursive descendants as (
        select child.id, child.status
        from agent_runs child where child.parent_run_id = new.id
        union all
        select child.id, child.status
        from agent_runs child
        join descendants parent on child.parent_run_id = parent.id
      )
      select 1 from descendants
      where status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
    ) then
      raise exception using
        errcode = '23514',
        constraint = 'agent_runs_terminal_tree_integrity',
        message = 'A terminal Agent run cannot have an active descendant';
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists agent_runs_terminal_tree_integrity on agent_runs;
create constraint trigger agent_runs_terminal_tree_integrity
after insert or update on agent_runs
deferrable initially deferred
for each row execute function enforce_agent_run_terminal_tree_integrity();

comment on function enforce_agent_run_terminal_tree_integrity() is
  'Deferred tree invariant: terminal ancestors and active descendants cannot coexist at commit.';

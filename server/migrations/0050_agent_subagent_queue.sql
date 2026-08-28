-- Make dispatched subagent runs durable work items instead of in-memory calls.
--
-- Dispatch previously created a child run and executed it inside the parent's
-- process, returning the outcome as a value. That works until the process dies:
-- the child row is left mid-flight with nobody waiting for it, and the parent's
-- answer is lost even though the work was recorded.
--
-- Rather than adding a second execution path beside the in-process one, a child is
-- now always enqueued and always claimed before it runs. The parent normally
-- claims its own children immediately, so the common case keeps its low latency,
-- but the queue row is the durable record: after a restart the rows are still
-- there to be claimed by another instance or swept. The parent reads outcomes from
-- the database either way, so there is exactly one code path to reason about.
alter table agent_runs
  add column if not exists queued_at timestamptz;
alter table agent_runs
  add column if not exists lease_token uuid;
alter table agent_runs
  add column if not exists lease_expires_at timestamptz;

-- A lease is meaningless without its deadline and vice versa.
alter table agent_runs
  drop constraint if exists agent_runs_lease_pairing_check;
alter table agent_runs
  add constraint agent_runs_lease_pairing_check
  check ((lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null));

-- Only a dispatched run is queued work. A root run is started by a request and
-- has no claiming step, so letting it sit in `queued` would make it invisible to
-- the user and to the claimer alike.
alter table agent_runs
  drop constraint if exists agent_runs_queued_is_dispatched_check;
alter table agent_runs
  add constraint agent_runs_queued_is_dispatched_check
  check (status <> 'queued' or parent_run_id is not null);

-- The claim query: oldest queued child first, skipping rows another worker holds.
create index if not exists agent_runs_queued_dispatch_idx
  on agent_runs (queued_at)
  where status = 'queued' and parent_run_id is not null;

-- Sweeping leases whose holder died.
create index if not exists agent_runs_lease_expiry_idx
  on agent_runs (lease_expires_at)
  where lease_expires_at is not null;

comment on column agent_runs.lease_token is
  'Held by the worker currently executing this dispatched run. An expired lease is failed rather than retried: a child''s progress through its own tool calls is not checkpointed, so re-running it from the start could repeat a side effect.';

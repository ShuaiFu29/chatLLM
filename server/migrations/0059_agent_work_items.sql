-- Durable work is separate from a Run's user-facing lifecycle record.
-- PostgreSQL is the source of truth; a queue transports only this row's id and
-- can be rebuilt by scanning queued rows after Redis loss.
create table if not exists agent_work_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  root_run_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  parent_work_item_id uuid references agent_work_items(id) on delete cascade,
  agent_version_id uuid references agent_versions(id) on delete set null,
  kind text not null,
  dispatch_key text,
  task_index smallint,
  payload jsonb not null,
  payload_hash text not null,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  fencing_generation bigint not null default 0,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint agent_work_items_run_unique unique (run_id),
  constraint agent_work_items_run_tree_fk
    foreign key (run_id, root_run_id)
    references agent_runs(id, root_run_id) on delete cascade,
  constraint agent_work_items_kind_check check (kind in ('root', 'subagent')),
  constraint agent_work_items_status_check check (status in (
    'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'
  )),
  constraint agent_work_items_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint agent_work_items_payload_size_check
    check (octet_length(payload::text) <= 262144),
  constraint agent_work_items_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint agent_work_items_attempt_check check (attempt_count >= 0),
  constraint agent_work_items_generation_check check (fencing_generation >= 0),
  constraint agent_work_items_task_index_check check (task_index is null or task_index >= 0),
  constraint agent_work_items_lease_pairing_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint agent_work_items_running_claim_check check (
    (status = 'running' and lease_token is not null and fencing_generation > 0)
    or (status <> 'running' and lease_token is null)
  ),
  constraint agent_work_items_terminal_metadata_check check (
    (status in ('succeeded', 'failed', 'cancelled') and completed_at is not null)
    or (status not in ('succeeded', 'failed', 'cancelled') and completed_at is null)
  ),
  constraint agent_work_items_shape_check check (
    (
      kind = 'root'
      and parent_work_item_id is null
      and dispatch_key is null
      and task_index is null
    )
    or
    (
      kind = 'subagent'
      and parent_work_item_id is not null
      and dispatch_key is not null
      and dispatch_key <> ''
      and task_index is not null
    )
  )
);

create unique index if not exists agent_work_items_dispatch_task_unique_idx
  on agent_work_items(parent_work_item_id, dispatch_key, task_index)
  where parent_work_item_id is not null;

create index if not exists agent_work_items_queue_idx
  on agent_work_items(available_at, created_at)
  where status = 'queued';

create index if not exists agent_work_items_lease_expiry_idx
  on agent_work_items(lease_expires_at)
  where status = 'running';

create index if not exists agent_work_items_root_updated_idx
  on agent_work_items(root_run_id, updated_at desc);

comment on table agent_work_items is
  'PostgreSQL source of truth for root and delegated Agent work. External queues carry only id and are rebuildable from queued rows.';

-- Every existing Run terminalization path already converges on agent_runs. Keep
-- work terminal state in the same transaction even while runtime adapters are
-- being migrated to claim/finalize work items directly.
create or replace function sync_agent_work_item_terminal_state()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('succeeded', 'failed', 'cancelled') then
    update agent_work_items
    set status = new.status,
        lease_token = null,
        lease_expires_at = null,
        error_code = new.error_code,
        error_message = new.error_message,
        completed_at = coalesce(new.completed_at, now()),
        updated_at = now()
    where run_id = new.id
      and status not in ('succeeded', 'failed', 'cancelled');
  end if;
  return new;
end;
$$;

drop trigger if exists agent_runs_sync_work_item_terminal_trigger on agent_runs;
create trigger agent_runs_sync_work_item_terminal_trigger
after update of status on agent_runs
for each row
when (new.status in ('succeeded', 'failed', 'cancelled'))
execute function sync_agent_work_item_terminal_state();

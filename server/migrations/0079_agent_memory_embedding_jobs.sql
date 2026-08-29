-- Durable asynchronous embedding/backfill for confirmed Agent Memory.
-- PostgreSQL owns retry/lease state; BullMQ only wakes a worker with memory_id.

-- Older deployments did not enforce the vector/model pair. A half-written pair
-- cannot be compared safely and would otherwise be neither complete nor
-- dispatchable, so normalize it before installing the invariant.
update agent_memories
set embedding = null,
    embedding_model = null,
    updated_at = now()
where (embedding is null) <> (embedding_model is null);

alter table agent_memories
  drop constraint if exists agent_memories_embedding_pair_check;
alter table agent_memories
  add constraint agent_memories_embedding_pair_check check (
    (embedding is null) = (embedding_model is null)
  );

create table if not exists agent_memory_embedding_jobs (
  memory_id uuid primary key,
  user_id uuid not null,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  worker_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint agent_memory_embedding_jobs_memory_user_fkey
    foreign key (memory_id, user_id)
    references agent_memories(id, user_id)
    on delete cascade,
  constraint agent_memory_embedding_jobs_status_check check (
    status in ('queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  constraint agent_memory_embedding_jobs_attempt_check check (
    attempt_count between 0 and 100
  ),
  constraint agent_memory_embedding_jobs_lease_check check (
    (
      status = 'running'
      and worker_id is not null
      and lease_token is not null
      and lease_expires_at is not null
      and completed_at is null
    )
    or (
      status <> 'running'
      and worker_id is null
      and lease_token is null
      and lease_expires_at is null
    )
  ),
  constraint agent_memory_embedding_jobs_terminal_check check (
    (status in ('queued', 'running') and completed_at is null)
    or (status in ('completed', 'failed', 'cancelled') and completed_at is not null)
  ),
  constraint agent_memory_embedding_jobs_error_check check (
    last_error_code is null
    or (
      status in ('queued', 'failed')
      and last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'
    )
  )
);

create index if not exists agent_memory_embedding_jobs_dispatch_idx
  on agent_memory_embedding_jobs(next_attempt_at, created_at, memory_id)
  where status = 'queued';

create index if not exists agent_memory_embedding_jobs_expired_lease_idx
  on agent_memory_embedding_jobs(lease_expires_at, memory_id)
  where status = 'running';

create or replace function sync_agent_memory_embedding_job()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'confirmed'
     or new.deleted_at is not null
     or new.superseded_by is not null
     or (new.expires_at is not null and new.expires_at <= now()) then
    update agent_memory_embedding_jobs job
    set status = 'cancelled',
        worker_id = null,
        lease_token = null,
        lease_expires_at = null,
        last_error_code = null,
        completed_at = coalesce(job.completed_at, now()),
        updated_at = now()
    where job.memory_id = new.id
      and job.status <> 'cancelled';
    return new;
  end if;

  if new.embedding is not null and new.embedding_model is not null then
    insert into agent_memory_embedding_jobs as job (
      memory_id, user_id, status, attempt_count, next_attempt_at,
      completed_at, updated_at
    ) values (
      new.id, new.user_id, 'completed', 0, now(), now(), now()
    )
    on conflict (memory_id) do update
      set status = 'completed',
          worker_id = null,
          lease_token = null,
          lease_expires_at = null,
          last_error_code = null,
          completed_at = coalesce(job.completed_at, now()),
          updated_at = now();
    return new;
  end if;

  insert into agent_memory_embedding_jobs as job (
    memory_id, user_id, status, attempt_count, next_attempt_at,
    completed_at, updated_at
  ) values (
    new.id, new.user_id, 'queued', 0, now(), null, now()
  )
  on conflict (memory_id) do update
    set user_id = excluded.user_id,
        status = 'queued',
        attempt_count = case
          when job.status in ('completed', 'failed', 'cancelled') then 0
          else job.attempt_count
        end,
        next_attempt_at = least(job.next_attempt_at, now()),
        worker_id = null,
        lease_token = null,
        lease_expires_at = null,
        last_error_code = null,
        completed_at = null,
        updated_at = now()
  where job.status <> 'running';
  return new;
end;
$$;

drop trigger if exists agent_memory_embedding_job_trigger on agent_memories;
create trigger agent_memory_embedding_job_trigger
after insert or update of status, deleted_at, superseded_by, expires_at, embedding, embedding_model
on agent_memories
for each row
execute function sync_agent_memory_embedding_job();

create or replace function sync_agent_memory_scope_embedding_jobs()
returns trigger
language plpgsql
as $$
begin
  if not new.enabled then
    update agent_memory_embedding_jobs job
    set status = 'cancelled',
        worker_id = null,
        lease_token = null,
        lease_expires_at = null,
        last_error_code = null,
        completed_at = coalesce(job.completed_at, now()),
        updated_at = now()
    from agent_memories memory
    where memory.id = job.memory_id
      and memory.user_id = new.user_id
      and memory.scope = new.scope
      and job.status in ('queued', 'running');
    return new;
  end if;

  insert into agent_memory_embedding_jobs (
    memory_id, user_id, status, attempt_count, next_attempt_at,
    completed_at, updated_at
  )
  select memory.id, memory.user_id, 'queued', 0, now(), null, now()
  from agent_memories memory
  where memory.user_id = new.user_id
    and memory.scope = new.scope
    and memory.status = 'confirmed'
    and memory.deleted_at is null
    and memory.superseded_by is null
    and (memory.expires_at is null or memory.expires_at > now())
    and memory.embedding is null
    and memory.embedding_model is null
  on conflict (memory_id) do update
    set status = 'queued',
        attempt_count = case
          when agent_memory_embedding_jobs.status in ('failed', 'cancelled') then 0
          else agent_memory_embedding_jobs.attempt_count
        end,
        next_attempt_at = least(agent_memory_embedding_jobs.next_attempt_at, now()),
        worker_id = null,
        lease_token = null,
        lease_expires_at = null,
        last_error_code = null,
        completed_at = null,
        updated_at = now()
  where agent_memory_embedding_jobs.status <> 'running';
  return new;
end;
$$;

drop trigger if exists agent_memory_scope_embedding_jobs_trigger
on agent_memory_scope_settings;
create trigger agent_memory_scope_embedding_jobs_trigger
after insert or update of enabled
on agent_memory_scope_settings
for each row
execute function sync_agent_memory_scope_embedding_jobs();

-- Existing confirmed active Memory is either already complete or becomes durable
-- backfill work. Candidate/quarantined rows are deliberately absent until a user
-- or policy transition confirms them.
insert into agent_memory_embedding_jobs (
  memory_id, user_id, status, attempt_count, next_attempt_at,
  completed_at, updated_at
)
select
  memory.id,
  memory.user_id,
  case when memory.embedding is not null and memory.embedding_model is not null
    then 'completed'
    else 'queued'
  end,
  0,
  now(),
  case when memory.embedding is not null and memory.embedding_model is not null
    then now()
    else null
  end,
  now()
from agent_memories memory
where memory.status = 'confirmed'
  and memory.deleted_at is null
  and memory.superseded_by is null
  and (memory.expires_at is null or memory.expires_at > now())
  and not exists (
    select 1
    from agent_memory_scope_settings setting
    where setting.user_id = memory.user_id
      and setting.scope = memory.scope
      and not setting.enabled
  )
on conflict (memory_id) do nothing;

comment on table agent_memory_embedding_jobs is
  'Durable, lease-fenced asynchronous embedding jobs. Contains identifiers and retry metadata only; Memory content remains in agent_memories.';

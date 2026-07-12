alter table files
  add column if not exists reserved_bytes bigint;

alter table files
  add column if not exists storage_bytes bigint;

update files
set reserved_bytes = case
  when status = 'uploading' and object_key is null then greatest(coalesce(file_size, 0), 0)
  else 0
end
where reserved_bytes is null;

update files
set storage_bytes = case
  when object_key is not null then greatest(coalesce(file_size, 0), 0)
  else 0
end
where storage_bytes is null;

alter table files
  alter column reserved_bytes set default 0,
  alter column reserved_bytes set not null,
  alter column storage_bytes set default 0,
  alter column storage_bytes set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'files_reserved_bytes_nonnegative_check'
      and conrelid = 'files'::regclass
  ) then
    alter table files
      add constraint files_reserved_bytes_nonnegative_check
      check (reserved_bytes >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'files_storage_bytes_nonnegative_check'
      and conrelid = 'files'::regclass
  ) then
    alter table files
      add constraint files_storage_bytes_nonnegative_check
      check (storage_bytes >= 0);
  end if;
end $$;

alter table files
  drop constraint if exists files_status_check;

alter table files
  add constraint files_status_check
  check (status in ('uploading', 'pending', 'processing', 'completed', 'failed', 'deleting'));

alter table upload_multipart_sessions
  drop constraint if exists upload_multipart_sessions_status_check;

alter table upload_multipart_sessions
  add constraint upload_multipart_sessions_status_check
  check (
    status in (
      'initiated',
      'uploading',
      'completing',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
      'expired'
    )
  );

drop index if exists upload_multipart_sessions_expires_at_idx;

create index upload_multipart_sessions_expires_at_idx
  on upload_multipart_sessions(expires_at)
  where status in ('initiated', 'uploading', 'cancelling');

create table if not exists file_content_claims (
  user_id uuid not null references users(id) on delete cascade,
  scope_key text not null,
  file_hash text not null,
  file_id uuid not null references files(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, scope_key, file_hash),
  constraint file_content_claims_scope_key_check check (char_length(scope_key) between 1 and 64),
  constraint file_content_claims_hash_check check (
    file_hash ~ '^[0-9a-f]{64}$'
  )
);

create unique index if not exists file_content_claims_file_id_idx
  on file_content_claims(file_id);

create index if not exists files_user_storage_accounting_idx
  on files(user_id)
  include (reserved_bytes, storage_bytes)
  where reserved_bytes > 0 or storage_bytes > 0;

with ranked_files as (
  select
    id,
    user_id,
    coalesce(project_space_id::text, '__global__') as scope_key,
    lower(file_hash) as normalized_hash,
    row_number() over (
      partition by user_id, coalesce(project_space_id::text, '__global__'), lower(file_hash)
      order by
        case status
          when 'completed' then 0
          when 'processing' then 1
          when 'pending' then 2
          when 'uploading' then 3
          when 'failed' then 4
          else 5
        end,
        (object_key is not null) desc,
        created_at asc,
        id asc
    ) as canonical_rank
  from files
  where file_hash ~* '^[0-9a-f]{64}$'
)
insert into file_content_claims (user_id, scope_key, file_hash, file_id)
select user_id, scope_key, normalized_hash, id
from ranked_files
where canonical_rank = 1
on conflict do nothing;

alter table file_ingestion_jobs
  add column if not exists attempt_id uuid;

alter table file_ingestion_jobs
  add column if not exists lease_token uuid;

alter table file_ingestion_jobs
  add column if not exists lease_expires_at timestamptz;

update file_ingestion_jobs
set attempt_id = gen_random_uuid()
where attempt_id is null;

update file_ingestion_jobs
set lease_token = gen_random_uuid()
where lease_token is null;

update file_ingestion_jobs
set lease_expires_at = now()
where lease_expires_at is null;

alter table file_ingestion_jobs
  alter column attempt_id set not null,
  alter column lease_token set not null,
  alter column lease_expires_at set not null;

create unique index if not exists file_ingestion_jobs_attempt_id_idx
  on file_ingestion_jobs(attempt_id);

create index if not exists file_ingestion_jobs_lease_expiry_idx
  on file_ingestion_jobs(lease_expires_at)
  where status in ('queued', 'processing');

alter table users
  add column if not exists deletion_status text not null default 'active';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_deletion_status_check'
      and conrelid = 'users'::regclass
  ) then
    alter table users
      add constraint users_deletion_status_check
      check (deletion_status in ('active', 'pending'));
  end if;
end $$;

alter table project_spaces
  add column if not exists status text not null default 'active';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'project_spaces_status_check'
      and conrelid = 'project_spaces'::regclass
  ) then
    alter table project_spaces
      add constraint project_spaces_status_check
      check (status in ('active', 'deleting'));
  end if;
end $$;

create table if not exists artifact_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  resource_key text not null unique,
  resource_type text not null,
  resource_id text not null,
  owner_user_id uuid references users(id) on delete set null,
  parent_job_id uuid references artifact_cleanup_jobs(id) on delete set null,
  status text not null default 'queued',
  step_state jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 10,
  next_attempt_at timestamptz,
  worker_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint artifact_cleanup_jobs_resource_type_check check (
    resource_type in ('file', 'project_space', 'account', 'avatar')
  ),
  constraint artifact_cleanup_jobs_status_check check (
    status in ('queued', 'processing', 'waiting', 'failed', 'completed')
  ),
  constraint artifact_cleanup_jobs_attempts_check check (
    attempts >= 0 and max_attempts > 0
  )
);

create index if not exists artifact_cleanup_jobs_ready_idx
  on artifact_cleanup_jobs(status, next_attempt_at, created_at)
  where status in ('queued', 'waiting', 'failed');

create index if not exists artifact_cleanup_jobs_lease_idx
  on artifact_cleanup_jobs(lease_expires_at)
  where status = 'processing';

create index if not exists artifact_cleanup_jobs_parent_idx
  on artifact_cleanup_jobs(parent_job_id, status);

create index if not exists project_spaces_user_active_idx
  on project_spaces(user_id, updated_at desc)
  where status = 'active';

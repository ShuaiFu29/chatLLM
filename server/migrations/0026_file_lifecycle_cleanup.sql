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

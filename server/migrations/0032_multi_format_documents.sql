alter table files
  add column if not exists document_kind text not null default 'markdown';

alter table files
  add column if not exists declared_mime_type text;

alter table files
  add column if not exists detected_mime_type text;

alter table files
  add column if not exists conversion_warning_count integer not null default 0;

alter table files
  drop constraint if exists files_document_kind_check;

alter table files
  add constraint files_document_kind_check
  check (document_kind in ('markdown', 'plaintext', 'pdf', 'docx', 'pptx', 'xlsx', 'csv'));

alter table files
  drop constraint if exists files_conversion_warning_count_check;

alter table files
  add constraint files_conversion_warning_count_check
  check (conversion_warning_count >= 0);

update files
set declared_mime_type = file_type
where declared_mime_type is null
  and file_type is not null;

alter table file_content_claims
  add column if not exists conversion_profile text not null default 'markdown-v1';

alter table file_content_claims
  drop constraint if exists file_content_claims_conversion_profile_check;

alter table file_content_claims
  add constraint file_content_claims_conversion_profile_check
  check (conversion_profile ~ '^[a-z0-9][a-z0-9-]{0,63}$');

alter table file_content_claims
  drop constraint if exists file_content_claims_pkey;

alter table file_content_claims
  add primary key (user_id, scope_key, file_hash, conversion_profile);

create table if not exists file_conversion_generations (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  attempt_id uuid,
  document_kind text not null,
  source_object_key text not null,
  markdown_object_key text not null,
  source_map_object_key text not null,
  manifest_object_key text not null,
  converter_name text not null,
  converter_version text not null,
  conversion_profile text not null,
  source_hash text not null,
  markdown_hash text,
  status text not null default 'converting',
  warning_count integer not null default 0,
  unit_count integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint file_conversion_generations_document_kind_check check (
    document_kind in ('markdown', 'plaintext', 'pdf', 'docx', 'pptx', 'xlsx', 'csv')
  ),
  constraint file_conversion_generations_conversion_profile_check check (
    conversion_profile ~ '^[a-z0-9][a-z0-9-]{0,63}$'
  ),
  constraint file_conversion_generations_source_hash_check check (
    source_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint file_conversion_generations_markdown_hash_check check (
    markdown_hash is null or markdown_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint file_conversion_generations_status_check check (
    status in ('converting', 'completed', 'completed_with_warnings', 'failed', 'superseded')
  ),
  constraint file_conversion_generations_warning_count_check check (warning_count >= 0),
  constraint file_conversion_generations_unit_count_check check (unit_count >= 0),
  constraint file_conversion_generations_completion_check check (
    (status in ('completed', 'completed_with_warnings', 'superseded') and completed_at is not null)
    or (status in ('converting', 'failed'))
  )
);

create index if not exists file_conversion_generations_file_created_idx
  on file_conversion_generations(file_id, created_at desc);

create index if not exists file_conversion_generations_active_status_idx
  on file_conversion_generations(status, updated_at)
  where status = 'converting';

alter table files
  add column if not exists active_conversion_generation_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'files_active_conversion_generation_fk'
      and conrelid = 'files'::regclass
  ) then
    alter table files
      add constraint files_active_conversion_generation_fk
      foreign key (active_conversion_generation_id)
      references file_conversion_generations(id)
      on delete set null;
  end if;
end $$;

alter table file_ingestion_jobs
  add column if not exists conversion_generation_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'file_ingestion_jobs_conversion_generation_fk'
      and conrelid = 'file_ingestion_jobs'::regclass
  ) then
    alter table file_ingestion_jobs
      add constraint file_ingestion_jobs_conversion_generation_fk
      foreign key (conversion_generation_id)
      references file_conversion_generations(id)
      on delete set null;
  end if;
end $$;

alter table file_chunks
  add column if not exists conversion_generation_id uuid;

alter table file_chunks
  add column if not exists source_unit_ids text[] not null default '{}'::text[];

alter table file_chunks
  add column if not exists source_locator jsonb not null default '{}'::jsonb;

alter table file_chunks
  add column if not exists content_hash text;

alter table file_chunks
  add column if not exists token_count integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'file_chunks_conversion_generation_fk'
      and conrelid = 'file_chunks'::regclass
  ) then
    alter table file_chunks
      add constraint file_chunks_conversion_generation_fk
      foreign key (conversion_generation_id)
      references file_conversion_generations(id)
      on delete cascade;
  end if;
end $$;

alter table file_chunks
  drop constraint if exists file_chunks_content_hash_check;

alter table file_chunks
  add constraint file_chunks_content_hash_check
  check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$');

alter table file_chunks
  drop constraint if exists file_chunks_token_count_check;

alter table file_chunks
  add constraint file_chunks_token_count_check
  check (token_count is null or token_count >= 0);

create index if not exists file_chunks_conversion_generation_idx
  on file_chunks(conversion_generation_id, chunk_index)
  where conversion_generation_id is not null;

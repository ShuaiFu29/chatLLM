alter table file_conversion_generations
  add column if not exists source_map_hash text;

alter table file_conversion_generations
  add column if not exists manifest_hash text;

alter table file_conversion_generations
  add column if not exists markdown_byte_size bigint;

alter table file_conversion_generations
  add column if not exists source_map_byte_size bigint;

alter table file_conversion_generations
  add column if not exists manifest_byte_size bigint;

alter table file_conversion_generations
  add column if not exists error_code text;

alter table file_conversion_generations
  drop constraint if exists file_conversion_generations_source_map_hash_check;

alter table file_conversion_generations
  add constraint file_conversion_generations_source_map_hash_check
  check (source_map_hash is null or source_map_hash ~ '^[0-9a-f]{64}$');

alter table file_conversion_generations
  drop constraint if exists file_conversion_generations_manifest_hash_check;

alter table file_conversion_generations
  add constraint file_conversion_generations_manifest_hash_check
  check (manifest_hash is null or manifest_hash ~ '^[0-9a-f]{64}$');

alter table file_conversion_generations
  drop constraint if exists file_conversion_generations_artifact_sizes_check;

alter table file_conversion_generations
  add constraint file_conversion_generations_artifact_sizes_check
  check (
    (markdown_byte_size is null or markdown_byte_size >= 0)
    and (source_map_byte_size is null or source_map_byte_size >= 0)
    and (manifest_byte_size is null or manifest_byte_size >= 0)
  );

alter table file_conversion_generations
  drop constraint if exists file_conversion_generations_error_code_check;

alter table file_conversion_generations
  add constraint file_conversion_generations_error_code_check
  check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,127}$');

alter table file_conversion_generations
  drop constraint if exists file_conversion_generations_artifact_integrity_check;

alter table file_conversion_generations
  add constraint file_conversion_generations_artifact_integrity_check
  check (
    (
      status = 'converting'
      and markdown_hash is null
      and source_map_hash is null
      and manifest_hash is null
      and markdown_byte_size is null
      and source_map_byte_size is null
      and manifest_byte_size is null
      and error_code is null
    )
    or (
      status in ('completed', 'completed_with_warnings', 'superseded')
      and markdown_hash is not null
      and source_map_hash is not null
      and manifest_hash is not null
      and markdown_byte_size is not null
      and source_map_byte_size is not null
      and manifest_byte_size is not null
      and error_code is null
    )
    or (
      status = 'failed'
      and error_code is not null
    )
  );

create unique index if not exists file_conversion_generations_id_file_idx
  on file_conversion_generations(id, file_id);

create unique index if not exists file_conversion_generations_attempt_id_idx
  on file_conversion_generations(attempt_id)
  where attempt_id is not null;

alter table files
  drop constraint if exists files_active_conversion_generation_fk;

alter table files
  add constraint files_active_conversion_generation_fk
  foreign key (active_conversion_generation_id, id)
  references file_conversion_generations(id, file_id)
  on delete set null (active_conversion_generation_id)
  not valid;

alter table files
  validate constraint files_active_conversion_generation_fk;

alter table file_ingestion_jobs
  drop constraint if exists file_ingestion_jobs_conversion_generation_fk;

alter table file_ingestion_jobs
  add constraint file_ingestion_jobs_conversion_generation_fk
  foreign key (conversion_generation_id, file_id)
  references file_conversion_generations(id, file_id)
  on delete set null (conversion_generation_id)
  not valid;

alter table file_ingestion_jobs
  validate constraint file_ingestion_jobs_conversion_generation_fk;

alter table file_chunks
  drop constraint if exists file_chunks_conversion_generation_fk;

alter table file_chunks
  add constraint file_chunks_conversion_generation_fk
  foreign key (conversion_generation_id, file_id)
  references file_conversion_generations(id, file_id)
  on delete cascade
  not valid;

alter table file_chunks
  validate constraint file_chunks_conversion_generation_fk;

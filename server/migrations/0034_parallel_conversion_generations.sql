alter table file_chunks
  drop constraint if exists file_chunks_file_id_chunk_index_key;

create unique index if not exists file_chunks_legacy_file_chunk_index_uidx
  on file_chunks(file_id, chunk_index)
  where conversion_generation_id is null;

create unique index if not exists file_chunks_generation_chunk_index_uidx
  on file_chunks(file_id, conversion_generation_id, chunk_index)
  where conversion_generation_id is not null;

alter table artifact_cleanup_jobs
  drop constraint if exists artifact_cleanup_jobs_resource_type_check;

alter table artifact_cleanup_jobs
  add constraint artifact_cleanup_jobs_resource_type_check check (
    resource_type in (
      'file',
      'project_space',
      'account',
      'avatar',
      'conversion_generation'
    )
  );

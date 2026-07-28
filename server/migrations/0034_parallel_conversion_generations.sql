alter table file_chunks
  drop constraint if exists file_chunks_file_id_chunk_index_key;

create unique index if not exists file_chunks_legacy_file_chunk_index_uidx
  on file_chunks(file_id, chunk_index)
  where conversion_generation_id is null;

create unique index if not exists file_chunks_generation_chunk_index_uidx
  on file_chunks(file_id, conversion_generation_id, chunk_index)
  where conversion_generation_id is not null;

create index if not exists file_chunks_content_search_idx
  on file_chunks
  using gin (to_tsvector('simple', content));

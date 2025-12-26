-- Update match_documents to support metadata filtering (for user_id isolation)
drop function if exists match_documents;

create or replace function match_documents (
  query_embedding vector(1024),
  match_threshold float,
  match_count int,
  filter jsonb DEFAULT '{}'
)
returns table (
  id bigint,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where 1 - (documents.embedding <=> query_embedding) > match_threshold
  and documents.metadata @> filter
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$$;

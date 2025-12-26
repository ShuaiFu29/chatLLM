-- 1. Enable pgvector extension
create extension if not exists vector;

-- 2. Create documents table (Support DeepSeek Embedding dimension: 1024)
-- Note: DeepSeek uses 1024 dimensions, OpenAI uses 1536.
-- We'll use 1024 here since we switched to DeepSeek.
create table if not exists documents (
  id bigserial primary key,
  content text,
  metadata jsonb,
  embedding vector(1024) -- DeepSeek embedding dimension
);

-- 3. Create a function to search for documents
create or replace function match_documents (
  query_embedding vector(1024),
  match_threshold float,
  match_count int
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
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$$;

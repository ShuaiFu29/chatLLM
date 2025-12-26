-- 1. Enable pgvector extension
create extension if not exists vector;

-- 2. Create documents table (Support ZhipuAI/DeepSeek Embedding dimension: 1024)
create table if not exists documents (
  id bigserial primary key,
  content text,
  metadata jsonb,
  embedding vector(1024), -- ZhipuAI embedding-2 uses 1024 dimensions
  file_id uuid references files(id) on delete cascade
);

-- 3. Create a function to search for documents with metadata filtering
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

-- 4. Create index for faster similarity search (IVFFlat)
-- Note: You might need to have some data before creating this index for optimal performance,
-- but creating it early is fine for small datasets.
create index if not exists documents_embedding_idx 
on documents 
using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

-- 5. Disable RLS on documents (Backend handles auth via metadata filter)
alter table documents disable row level security;

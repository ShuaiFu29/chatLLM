-- Enable the pgvector extension to work with embedding vectors
create extension if not exists vector;

-- Drop existing table and function to reset schema
drop function if exists match_documents;
drop table if exists documents;

-- Create a table to store your documents
create table documents (
  id bigserial primary key,
  content text, -- corresponds to Document.pageContent
  metadata jsonb, -- corresponds to Document.metadata
  embedding vector(1024), -- ZhipuAI embedding-2 returning 1024 dimensions
  file_id uuid -- Link to the files table
);

-- Create a function to search for documents
create or replace function match_documents (
  query_embedding vector(1024),
  match_threshold float,
  match_count int,
  filter jsonb DEFAULT '{}'
) returns table (
  id bigint,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
as $$
#variable_conflict use_column
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

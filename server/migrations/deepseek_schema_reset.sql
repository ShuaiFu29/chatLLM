-- 1. Enable vector extension
create extension if not exists vector;

-- 2. Reset Documents Table
-- We DROP it to ensure no 1536-dim data remains
DROP TABLE IF EXISTS documents CASCADE;

create table documents (
  id bigserial primary key,
  content text,
  metadata jsonb,
  embedding vector(1024), -- DeepSeek Dimension
  file_id uuid references files(id) ON DELETE CASCADE, -- Link to files table
  created_at timestamptz default now()
);

-- 3. Reset Match Function
-- Drop old versions to prevent overload conflicts
DROP FUNCTION IF EXISTS match_documents(vector(1536), float, int);
DROP FUNCTION IF EXISTS match_documents(vector(1536), float, int, jsonb);
DROP FUNCTION IF EXISTS match_documents(vector(1024), float, int);
DROP FUNCTION IF EXISTS match_documents(vector(1024), float, int, jsonb);

CREATE OR REPLACE FUNCTION match_documents (
  query_embedding vector(1024),
  match_threshold float,
  match_count int,
  filter jsonb DEFAULT '{}'
)
RETURNS TABLE (
  id bigint,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) AS similarity
  FROM documents
  WHERE 1 - (documents.embedding <=> query_embedding) > match_threshold
  AND (filter = '{}' OR documents.metadata @> filter)
  ORDER BY documents.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

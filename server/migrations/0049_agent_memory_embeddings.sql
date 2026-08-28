-- Relevance ranking for memory recall.
--
-- Recall ordered memories by trust, then kind, then recency. That is predictable
-- but it is not relevance: with a few dozen memories in scope, the ones injected
-- into a prompt had nothing to do with what the user actually asked.
--
-- The vector is stored as a plain `real[]`, deliberately not as a pgvector column.
-- Requiring an extension would make every deployment install one before it could
-- migrate -- the same class of infrastructure dependency already filed for the
-- Elasticsearch tokeniser. Recall fetches at most a few dozen scope-eligible rows
-- and ranks them in the application, which needs no extension and no index. This
-- is the right trade at this size; a store of millions of memories per user would
-- need pgvector and a different design.
alter table agent_memories
  add column if not exists embedding real[];

-- Which model produced the vector. Embeddings from different models are not
-- comparable, so a model change has to invalidate them rather than silently
-- produce nonsense distances.
alter table agent_memories
  add column if not exists embedding_model text;

alter table agent_memories
  drop constraint if exists agent_memories_embedding_pairing_check;
alter table agent_memories
  add constraint agent_memories_embedding_pairing_check
  check ((embedding is null and embedding_model is null)
    or (embedding is not null and embedding_model is not null));

-- A zero-length vector would rank as equally distant from everything.
alter table agent_memories
  drop constraint if exists agent_memories_embedding_dimension_check;
alter table agent_memories
  add constraint agent_memories_embedding_dimension_check
  check (embedding is null or cardinality(embedding) between 1 and 4096);

comment on column agent_memories.embedding is
  'Embedding of `content` as a plain real[]; ranking happens in the application. NULL when embedding was unavailable at write time, in which case recall falls back to deterministic ordering.';

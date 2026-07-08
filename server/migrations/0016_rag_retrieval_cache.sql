alter table project_spaces
  add column if not exists knowledge_version bigint not null default 1;

alter table project_spaces
  add column if not exists knowledge_version_updated_at timestamptz not null default now();

create table if not exists rag_index_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_space_id uuid references project_spaces(id) on delete cascade,
  knowledge_version bigint not null default 1,
  vector_version bigint not null default 1,
  bm25_version bigint not null default 1,
  graph_version bigint not null default 1,
  chunk_strategy_version text not null default 'markdown-v1:chunk1000-overlap100',
  embedding_model text not null default '',
  embedding_dimension integer not null default 0,
  settings_fingerprint text not null default '',
  updated_at timestamptz not null default now()
);

create unique index if not exists rag_index_versions_user_project_idx
  on rag_index_versions(user_id, project_space_id);

create index if not exists rag_index_versions_user_updated_idx
  on rag_index_versions(user_id, updated_at desc);

create table if not exists rag_retrieval_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_space_id uuid references project_spaces(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  cache_kind text not null,
  retrieval_scope_fingerprint text not null,
  normalized_query text not null,
  original_query text not null default '',
  query_hash text not null,
  query_terms text[] not null default '{}'::text[],
  evidence jsonb not null default '[]'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  trace_summary jsonb not null default '{}'::jsonb,
  hit_count integer not null default 0,
  last_used_at timestamptz,
  expires_at timestamptz not null default now() + interval '6 hours',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rag_retrieval_cache_kind_check
    check (cache_kind in ('query', 'subquery', 'conversation_evidence'))
);

create index if not exists rag_retrieval_cache_lookup_idx
  on rag_retrieval_cache(user_id, project_space_id, cache_kind, retrieval_scope_fingerprint, query_hash, expires_at desc);

create index if not exists rag_retrieval_cache_scope_recent_idx
  on rag_retrieval_cache(user_id, project_space_id, cache_kind, retrieval_scope_fingerprint, updated_at desc);

create index if not exists rag_retrieval_cache_conversation_recent_idx
  on rag_retrieval_cache(user_id, conversation_id, retrieval_scope_fingerprint, updated_at desc)
  where conversation_id is not null;

create index if not exists rag_retrieval_cache_expiry_idx
  on rag_retrieval_cache(expires_at);

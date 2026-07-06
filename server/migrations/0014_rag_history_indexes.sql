create index if not exists rag_runs_user_created_idx
  on rag_runs (user_id, created_at desc);

create index if not exists rag_retrieval_cache_conversation_lookup_idx
  on rag_retrieval_cache(
    user_id,
    project_space_id,
    conversation_id,
    cache_kind,
    retrieval_scope_fingerprint,
    query_hash,
    expires_at desc
  );

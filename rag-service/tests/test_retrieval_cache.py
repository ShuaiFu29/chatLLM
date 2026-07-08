import unittest

from retrieval_cache import (
    InMemoryRetrievalCache,
    build_retrieval_scope_fingerprint,
    normalize_query,
    query_similarity,
)


class RetrievalCacheTests(unittest.TestCase):
    def test_scope_fingerprint_changes_when_knowledge_or_index_version_changes(self):
        base_scope = {
            "user_id": "user-1",
            "project_space_id": "space-1",
            "knowledge_version": 7,
            "vector_version": 3,
            "bm25_version": 5,
            "graph_version": 2,
            "chunk_strategy_version": "markdown-v1:1000:100",
            "embedding_model": "text-embedding-v4",
            "embedding_dimension": 1024,
            "settings_fingerprint": "settings-a",
        }

        same = build_retrieval_scope_fingerprint(dict(base_scope))
        changed_knowledge = build_retrieval_scope_fingerprint({**base_scope, "knowledge_version": 8})
        changed_vector = build_retrieval_scope_fingerprint({**base_scope, "vector_version": 4})
        changed_embedding = build_retrieval_scope_fingerprint({**base_scope, "embedding_model": "text-embedding-v5"})

        self.assertEqual(same, build_retrieval_scope_fingerprint(dict(base_scope)))
        self.assertNotEqual(same, changed_knowledge)
        self.assertNotEqual(same, changed_vector)
        self.assertNotEqual(same, changed_embedding)

    def test_query_normalization_and_similarity_support_paraphrase_reuse_without_exact_match(self):
        exact = normalize_query("  OAuth refresh-token rotation? ")
        paraphrase = normalize_query("How are OAuth refresh tokens rotated")

        self.assertEqual(exact, "oauth refresh token rotation")
        self.assertNotEqual(exact, paraphrase)
        self.assertGreaterEqual(query_similarity(exact, paraphrase), 0.55)
        self.assertLess(query_similarity("oauth refresh token rotation", "write a weekly report"), 0.25)

    def test_in_memory_cache_rejects_entries_from_other_scope_or_user(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v2")
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="oauth refresh token rotation",
            original_query="OAuth refresh token rotation",
            scope_fingerprint="scope-v1",
            documents=[{"id": "old", "content": "old", "metadata": {"filename": "old.md", "file_id": "old", "chunk_index": 0}}],
            quality={"overall_score": 1, "evidence_label": "strong"},
        )

        self.assertIsNone(cache.find_exact("user-1", "space-1", "conversation-1", "scope-v2", "oauth refresh token rotation"))
        self.assertIsNone(cache.find_exact("user-2", "space-1", "conversation-1", "scope-v1", "oauth refresh token rotation"))

    def test_in_memory_cache_finds_similar_recent_evidence_inside_same_scope(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="oauth refresh token rotation",
            original_query="OAuth refresh token rotation",
            scope_fingerprint="scope-v1",
            documents=[{"id": "cached", "content": "OAuth tokens rotate.", "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 0}}],
            quality={"overall_score": 0.8, "evidence_label": "strong"},
        )

        hit = cache.find_similar("user-1", "space-1", "conversation-1", "scope-v1", "how are oauth refresh tokens rotated")

        self.assertIsNotNone(hit)
        self.assertEqual(hit["documents"][0]["id"], "cached")
        self.assertGreaterEqual(hit["query_similarity"], 0.55)

    def test_query_and_subquery_cache_are_scoped_to_the_current_conversation(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        document = {
            "id": "cached",
            "content": "OAuth tokens rotate inside conversation one.",
            "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 0},
        }
        quality = {"overall_score": 0.8, "evidence_label": "strong"}

        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="oauth refresh token rotation",
            original_query="OAuth refresh token rotation",
            scope_fingerprint="scope-v1",
            documents=[document],
            quality=quality,
        )
        cache.upsert_subquery_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="oauth refresh token rotation",
            original_query="OAuth refresh token rotation",
            scope_fingerprint="scope-v1",
            documents=[document],
            quality=quality,
        )

        self.assertIsNotNone(cache.find_exact(
            "user-1", "space-1", "conversation-1", "scope-v1", "oauth refresh token rotation"
        ))
        self.assertIsNone(cache.find_exact(
            "user-1", "space-1", "conversation-2", "scope-v1", "oauth refresh token rotation"
        ))
        self.assertIsNone(cache.find_similar(
            "user-1", "space-1", "conversation-2", "scope-v1", "how are oauth refresh tokens rotated"
        ))
        self.assertIsNone(cache.find_subquery(
            "user-1", "space-1", "conversation-2", "scope-v1", "oauth refresh token rotation"
        ))
        self.assertIsNone(cache.find_exact(
            "user-1", "space-1", None, "scope-v1", "oauth refresh token rotation"
        ))


if __name__ == "__main__":
    unittest.main()

import os
import json
import time
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

import db
from config import load_settings
from retrieval_cache import (
    InMemoryRetrievalCache,
    RedisL1RetrievalCache,
    build_retrieval_request_fingerprint,
    build_retrieval_scope_fingerprint,
    normalize_query,
    query_similarity,
)


class RetrievalCacheTests(unittest.TestCase):
    def test_cache_redis_must_be_separate_when_enabled(self):
        base_environment = {
            "DATABASE_URL": "postgres://test:test@localhost:5432/test",
            "S3_ENDPOINT": "http://localhost:9000",
            "S3_ACCESS_KEY": "test-access",
            "S3_SECRET_KEY": "test-secret",
            "MILVUS_URI": "http://localhost:19530",
            "MILVUS_COLLECTION": "test_chunks",
            "EMBEDDING_PROVIDER": "local",
            "EMBEDDING_DIMENSION": "32",
            "RAG_SERVICE_TOKEN": "x" * 32,
            "REDIS_URL": "redis://queue:6379/0",
            "REDIS_CACHE_ENABLED": "true",
        }
        with patch.dict(os.environ, base_environment, clear=True):
            missing_url = load_settings()
        with patch.dict(os.environ, {
            **base_environment,
            "CACHE_REDIS_URL": base_environment["REDIS_URL"],
        }, clear=True):
            shared_url = load_settings()
        with patch.dict(os.environ, {
            **base_environment,
            "CACHE_REDIS_URL": "redis://cache:6379/0",
        }, clear=True):
            separate_url = load_settings()

        self.assertFalse(missing_url.redis_cache_enabled)
        self.assertIn("not configured", missing_url.redis_cache_disabled_reason)
        self.assertFalse(shared_url.redis_cache_enabled)
        self.assertIn("separate", shared_url.redis_cache_disabled_reason)
        self.assertTrue(separate_url.redis_cache_enabled)
        self.assertEqual(separate_url.redis_cache_disabled_reason, "")

    def test_exact_key_crosses_conversations_but_tracks_pipeline_settings(self):
        cache = RedisL1RetrievalCache(backend=MagicMock(), redis_client=MagicMock())
        key_one = cache._key("user-1", "space-1", "conversation-1", "scope-1", "token rotation")
        key_two = cache._key("user-1", "space-1", "conversation-2", "scope-1", "token rotation")
        self.assertEqual(key_one, key_two)
        self.assertNotEqual(
            key_one,
            cache._key("user-2", "space-1", "conversation-2", "scope-1", "token rotation"),
        )

        base = build_retrieval_request_fingerprint(
            "scope-1", ["vector", "bm25"], 5, 0.1, "gte:v1"
        )
        self.assertNotEqual(
            base,
            build_retrieval_request_fingerprint(
                "scope-1", ["vector", "bm25", "graph"], 5, 0.1, "gte:v1"
            ),
        )
        self.assertNotEqual(
            base,
            build_retrieval_request_fingerprint(
                "scope-1", ["vector", "bm25"], 5, 0.1, "gte:v2"
            ),
        )

    def test_redis_l1_exact_hit_skips_postgres_lookup(self):
        backend = MagicMock()
        redis_client = MagicMock()
        redis_client.get.return_value = json.dumps({
            "id": "cache-1",
            "documents": [{"id": "chunk-1"}],
            "quality": {"overall_score": 0.8},
            "expires_at": time.time() + 60,
        })
        cache = RedisL1RetrievalCache(
            backend=backend,
            redis_client=redis_client,
            ttl_seconds=60,
        )

        entry = cache.find_exact("user-1", "space-1", None, "scope-1", "token rotation")

        self.assertTrue(entry["l1_cache_hit"])
        self.assertEqual(entry["query_similarity"], 1.0)
        backend.find_exact.assert_not_called()

    def test_redis_l1_failure_falls_back_to_postgres(self):
        backend = MagicMock()
        backend.find_exact.return_value = {
            "id": "cache-2",
            "documents": [],
            "expires_at": time.time() + 60,
        }
        redis_client = MagicMock()
        redis_client.get.side_effect = ConnectionError("redis unavailable")
        cache = RedisL1RetrievalCache(backend=backend, redis_client=redis_client, ttl_seconds=60)

        entry = cache.find_exact("user-1", "space-1", None, "scope-1", "token rotation")

        self.assertEqual(entry["id"], "cache-2")
        backend.find_exact.assert_called_once()

    def test_redis_l1_populates_after_durable_query_upsert(self):
        backend = MagicMock()
        backend.find_exact.return_value = {
            "id": "cache-3",
            "documents": [],
            "expires_at": time.time() + 60,
        }
        redis_client = MagicMock()
        cache = RedisL1RetrievalCache(backend=backend, redis_client=redis_client, ttl_seconds=60)

        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id=None,
            normalized_query="token rotation",
            original_query="Token rotation",
            scope_fingerprint="scope-1",
            documents=[],
            quality={"overall_score": 0.8},
        )

        backend.upsert_query_cache.assert_called_once()
        redis_client.setex.assert_called_once()

    def test_redis_l1_respects_durable_expiry_and_short_circuits_after_failure(self):
        backend = MagicMock()
        backend.find_exact.return_value = {
            "id": "cache-4",
            "documents": [],
            "expires_at": time.time() + 3,
        }
        redis_client = MagicMock()
        redis_client.get.side_effect = ConnectionError("redis unavailable")
        cache = RedisL1RetrievalCache(
            backend=backend,
            redis_client=redis_client,
            ttl_seconds=60,
            failure_cooldown_seconds=10,
        )

        cache.find_exact("user-1", "space-1", None, "scope-1", "first")
        cache.find_exact("user-1", "space-1", None, "scope-1", "second")

        self.assertEqual(redis_client.get.call_count, 1)
        redis_client.setex.assert_not_called()
        self.assertEqual(backend.find_exact.call_count, 2)

        healthy_redis = MagicMock()
        healthy_cache = RedisL1RetrievalCache(
            backend=backend,
            redis_client=healthy_redis,
            ttl_seconds=60,
        )
        healthy_cache._set("cache-key", backend.find_exact.return_value)
        used_ttl = healthy_redis.setex.call_args.args[1]
        self.assertGreaterEqual(used_ttl, 1)
        self.assertLessEqual(used_ttl, 3)

    def test_redis_l1_discards_expired_payload(self):
        backend = MagicMock()
        backend.find_exact.return_value = None
        redis_client = MagicMock()
        redis_client.get.return_value = json.dumps({
            "id": "stale-cache",
            "documents": [],
            "expires_at": time.time() - 1,
        })
        cache = RedisL1RetrievalCache(backend=backend, redis_client=redis_client, ttl_seconds=60)

        self.assertIsNone(cache.find_exact("user-1", "space-1", None, "scope-1", "stale"))
        redis_client.delete.assert_called_once()
        backend.find_exact.assert_called_once()

    def test_redis_singleflight_has_one_leader_and_token_safe_release(self):
        redis_client = MagicMock()
        redis_client.set.side_effect = [True, False]
        cache = RedisL1RetrievalCache(
            backend=MagicMock(),
            redis_client=redis_client,
            singleflight_wait_ms=50,
            singleflight_lock_seconds=5,
        )

        leader = cache.acquire_singleflight("user-1", "space-1", "scope-1", "token rotation")
        waiter = cache.acquire_singleflight("user-1", "space-1", "scope-1", "token rotation")

        self.assertEqual(leader["role"], "leader")
        self.assertEqual(waiter["role"], "waiter")
        self.assertEqual(leader["lock_key"], waiter["lock_key"])
        redis_client.set.assert_any_call(
            leader["lock_key"],
            leader["token"],
            nx=True,
            ex=5,
        )

        cache.release_singleflight(leader)
        redis_client.eval.assert_called_once()
        self.assertEqual(redis_client.eval.call_args.args[-2:], (leader["lock_key"], leader["token"]))

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

    def test_all_space_fingerprint_tracks_every_project_version_independent_of_order(self):
        base_scope = {
            "user_id": "user-1",
            "project_space_id": None,
            "knowledge_version": 9,
            "project_versions": [
                {"project_space_id": "space-low", "knowledge_version": 3},
                {"project_space_id": "space-high", "knowledge_version": 9},
            ],
            "vector_version": 1,
            "bm25_version": 1,
            "graph_version": 1,
            "chunk_strategy_version": "markdown-v1:1000:100",
            "embedding_model": "text-embedding-v4",
            "embedding_dimension": 1024,
            "settings_fingerprint": "settings-a",
        }

        original = build_retrieval_scope_fingerprint(base_scope)
        reordered = build_retrieval_scope_fingerprint({
            **base_scope,
            "project_versions": list(reversed(base_scope["project_versions"])),
        })
        changed_non_maximum = build_retrieval_scope_fingerprint({
            **base_scope,
            "project_versions": [
                {"project_space_id": "space-low", "knowledge_version": 4},
                {"project_space_id": "space-high", "knowledge_version": 9},
            ],
        })

        self.assertEqual(original, reordered)
        self.assertNotEqual(original, changed_non_maximum)

    def test_project_scope_fingerprint_ignores_other_project_versions(self):
        project_scope = {
            "user_id": "user-1",
            "project_space_id": "space-1",
            "knowledge_version": 7,
            "project_versions": [
                {"project_space_id": "space-2", "knowledge_version": 99},
            ],
            "vector_version": 3,
            "bm25_version": 5,
            "graph_version": 2,
            "chunk_strategy_version": "markdown-v1:1000:100",
            "embedding_model": "text-embedding-v4",
            "embedding_dimension": 1024,
            "settings_fingerprint": "settings-a",
        }

        original = build_retrieval_scope_fingerprint(project_scope)
        unrelated_change = build_retrieval_scope_fingerprint({
            **project_scope,
            "project_versions": [
                {"project_space_id": "space-2", "knowledge_version": 100},
            ],
        })

        self.assertEqual(original, unrelated_change)
        self.assertNotEqual(
            original,
            build_retrieval_scope_fingerprint({**project_scope, "knowledge_version": 8}),
        )

    def test_database_all_space_scope_returns_complete_project_versions(self):
        cursor = MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchall.return_value = [
            {"project_space_id": "space-high", "knowledge_version": 9},
            {"project_space_id": "space-low", "knowledge_version": 3},
        ]
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.cursor.return_value = cursor

        index_version = {
            "vector_version": 1,
            "bm25_version": 1,
            "graph_version": 1,
            "chunk_strategy_version": "markdown-v1:chunk1000-overlap100",
            "embedding_model": "text-embedding-v4",
            "embedding_dimension": 1024,
            "settings_fingerprint": "settings-a",
        }
        with patch("db.get_conn", return_value=connection), patch(
            "db._ensure_rag_index_version",
            return_value=index_version,
        ):
            scope = db.get_retrieval_scope("user-1", None)

        statement = cursor.execute.call_args.args[0].lower()
        self.assertNotIn("max(", statement)
        self.assertIn("knowledge_version", statement)
        self.assertEqual(scope["knowledge_version"], 9)
        self.assertEqual(
            [
                (item["project_space_id"], item["knowledge_version"])
                for item in scope["project_versions"]
            ],
            [("space-high", 9), ("space-low", 3)],
        )
        self.assertTrue(all(
            item["chunk_strategy_version"] == "markdown-v1:chunk1000-overlap100"
            for item in scope["project_versions"]
        ))

    @unittest.skipUnless(
        os.environ.get("RETRIEVAL_CACHE_POSTGRES_INTEGRATION") == "1"
        and os.environ.get("TEST_DATABASE_URL"),
        "PostgreSQL retrieval-cache integration is not configured",
    )
    def test_postgres_all_space_fingerprint_changes_for_non_maximum_version(self):
        self.assertEqual(os.environ.get("DATABASE_URL"), os.environ.get("TEST_DATABASE_URL"))
        user_id = str(uuid4())
        low_space_id = str(uuid4())
        high_space_id = str(uuid4())
        github_id = uuid4().int % 9_000_000_000_000_000

        with db.get_conn() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "insert into users (id, github_id, username) values (%s, %s, %s)",
                    (user_id, github_id, f"audit-cache-{user_id}"),
                )
                cursor.execute(
                    """
                    insert into project_spaces (id, user_id, name, knowledge_version)
                    values (%s, %s, 'low-version-space', 3),
                           (%s, %s, 'high-version-space', 9)
                    """,
                    (low_space_id, user_id, high_space_id, user_id),
                )
            connection.commit()

        try:
            before_scope = db.get_retrieval_scope(user_id, None)
            before_fingerprint = build_retrieval_scope_fingerprint(before_scope)

            with db.get_conn() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "update project_spaces set knowledge_version = 4 where id = %s",
                        (low_space_id,),
                    )
                connection.commit()

            after_scope = db.get_retrieval_scope(user_id, None)
            after_fingerprint = build_retrieval_scope_fingerprint(after_scope)

            self.assertEqual(before_scope["knowledge_version"], 9)
            self.assertEqual(after_scope["knowledge_version"], 9)
            self.assertNotEqual(before_fingerprint, after_fingerprint)
        finally:
            with db.get_conn() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("delete from users where id = %s", (user_id,))
                connection.commit()

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

    def test_exact_query_cache_crosses_conversations_but_evidence_cache_does_not(self):
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
        cache.upsert_conversation_evidence(
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
        self.assertIsNotNone(cache.find_exact(
            "user-1", "space-1", "conversation-2", "scope-v1", "oauth refresh token rotation"
        ))
        self.assertIsNotNone(cache.find_subquery(
            "user-1", "space-1", "conversation-2", "scope-v1", "oauth refresh token rotation"
        ))
        self.assertIsNone(cache.find_conversation_evidence(
            "user-1", "space-1", "conversation-2", "scope-v1", "how are oauth refresh tokens rotated"
        ))
        self.assertIsNotNone(cache.find_conversation_evidence(
            "user-1", "space-1", "conversation-1", "scope-v1", "how are oauth refresh tokens rotated"
        ))
        self.assertIsNotNone(cache.find_exact(
            "user-1", "space-1", None, "scope-v1", "oauth refresh token rotation"
        ))


if __name__ == "__main__":
    unittest.main()

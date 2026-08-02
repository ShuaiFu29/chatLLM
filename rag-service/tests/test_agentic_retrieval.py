import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from agentic_retrieval import (
    PlannedRetrievalUnavailableError,
    _classify_question,
    _request_cache_fingerprint,
    _select_diverse_documents,
    agentic_retrieve,
    default_rerank_documents,
)
from evaluation import evaluate_retrieval_quality
from query_planner import plan_queries, resolve_standalone_query
from retrieval_cache import InMemoryRetrievalCache
from retrieval import RetrievalDocuments, retrieve_documents

class AgenticRetrievalTests(unittest.TestCase):
    def test_agentic_retrieve_raises_when_every_planned_query_fails(self):
        def unavailable(*_args, **_kwargs):
            raise RuntimeError("private upstream detail")

        with self.assertRaisesRegex(
            PlannedRetrievalUnavailableError,
            "All .* planned retrieval queries failed",
        ) as raised:
            agentic_retrieve(
                query="How does OAuth refresh token rotation work?",
                user_id="user-1",
                project_space_id="space-1",
                retrieve_fn=unavailable,
                cache_store=None,
            )

        self.assertNotIn("private upstream detail", str(raised.exception))

    @staticmethod
    def _cache_scope(base_scope: str, query: str, limit: int = 5, threshold: float = 0.1) -> str:
        return _request_cache_fingerprint(
            base_scope,
            _classify_question(query)["routes"],
            limit,
            threshold,
            default_rerank_documents,
        )

    def test_diverse_selection_caps_source_concentration_without_query_specific_rules(self):
        documents = [
            {"id": "guide-1", "content": "安装步骤", "metadata": {"filename": "guide.md", "file_id": "guide", "chunk_index": 1}},
            {"id": "guide-2", "content": "回滚步骤", "metadata": {"filename": "guide.md", "file_id": "guide", "chunk_index": 2}},
            {"id": "guide-3", "content": "附录", "metadata": {"filename": "guide.md", "file_id": "guide", "chunk_index": 3}},
            {"id": "api-1", "content": "接口约束", "metadata": {"filename": "api.md", "file_id": "api", "chunk_index": 0}},
            {"id": "ops-1", "content": "运维约束", "metadata": {"filename": "ops.md", "file_id": "ops", "chunk_index": 0}},
        ]

        selected = _select_diverse_documents(documents, 4)

        self.assertEqual([item["id"] for item in selected], ["guide-1", "guide-2", "api-1", "ops-1"])

    def test_agentic_retrieve_reports_query_cache_write_failure_without_failing_retrieval(self):
        class FailingWriteCache(InMemoryRetrievalCache):
            def upsert_query_cache(self, *args, **kwargs):
                raise RuntimeError("cache write timeout")

        cache = FailingWriteCache(scope_fingerprint="scope-v1")

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            return [{
                "id": "chunk-cache-write",
                "content": "OAuth refresh token rotation revokes the previous token and issues a new HttpOnly refresh session.",
                "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 3},
                "similarity": 0.9,
                "retrieval_score": 0.9,
            }]

        result = agentic_retrieve(
            query="How does OAuth refresh token rotation work?",
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertEqual(result["results"][0]["id"], "chunk-cache-write")
        cache_write_steps = [
            step for step in result["trace_steps"]
            if step["step_type"] == "cache_write" and step["input"].get("cache_kind") == "query"
        ]
        self.assertEqual(cache_write_steps[-1]["status"], "partial")
        self.assertEqual(cache_write_steps[-1]["output"]["error"], "Cache write failed")
        self.assertNotIn("cache write timeout", str(result))

    def test_agentic_retrieve_reports_cache_hit_side_effect_failure_without_retrieving(self):
        class FailingHitCache(InMemoryRetrievalCache):
            def record_hit(self, entry):
                raise RuntimeError("hit counter unavailable")

        cache = FailingHitCache(scope_fingerprint="scope-v1")
        query = "How does OAuth refresh token rotation work?"
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="how does oauth refresh token rotation work?",
            original_query="How does OAuth refresh token rotation work?",
            scope_fingerprint=self._cache_scope("scope-v1", query),
            documents=[
                {
                    "id": "chunk-cached-oauth",
                    "content": "OAuth refresh token rotation reissues the HttpOnly session and invalidates the previous refresh token.",
                    "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 1},
                    "similarity": 0.93,
                    "retrieval_score": 0.93,
                }
            ],
            quality={"overall_score": 0.82, "evidence_label": "strong"},
        )

        retrieve_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(query)
            return []

        result = agentic_retrieve(
            query=query,
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertEqual(retrieve_calls, [])
        self.assertEqual(result["results"][0]["id"], "chunk-cached-oauth")
        cache_side_effect_steps = [
            step for step in result["trace_steps"]
            if step["step_type"] == "cache_side_effect"
        ]
        self.assertEqual(cache_side_effect_steps[-1]["status"], "partial")
        self.assertEqual(cache_side_effect_steps[-1]["output"]["error"], "Cache side effect failed")
        self.assertNotIn("hit counter unavailable", str(result))

    def test_agentic_retrieve_reuses_exact_cached_evidence_without_retrieving(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        query = "How does OAuth refresh token rotation work?"
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="how does oauth refresh token rotation work?",
            original_query="How does OAuth refresh token rotation work?",
            scope_fingerprint=self._cache_scope("scope-v1", query),
            documents=[
                {
                    "id": "chunk-cached-oauth",
                    "content": "OAuth refresh token rotation reissues the HttpOnly session and invalidates the previous refresh token.",
                    "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 1},
                    "similarity": 0.93,
                    "retrieval_score": 0.93,
                }
            ],
            quality={"overall_score": 0.82, "evidence_label": "strong"},
        )

        retrieve_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(query)
            return []

        result = agentic_retrieve(
            query=query,
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertEqual(retrieve_calls, [])
        self.assertEqual(result["results"][0]["id"], "chunk-cached-oauth")
        self.assertEqual(result["cache"]["status"], "hit")
        step_types = [step["step_type"] for step in result["trace_steps"]]
        self.assertIn("cache_lookup", step_types)
        self.assertIn("evidence_reuse", step_types)

    def test_singleflight_coalesces_concurrent_exact_misses_across_conversations(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        query = "How does OAuth refresh token rotation work?"
        retrieve_calls = 0
        calls_lock = threading.Lock()

        def fake_retrieve(planned_query, user_id, project_space_id, limit, threshold):
            nonlocal retrieve_calls
            with calls_lock:
                retrieve_calls += 1
            time.sleep(0.03)
            return [{
                "id": "chunk-oauth",
                "content": "OAuth refresh token rotation invalidates the previous refresh token and issues a new HttpOnly session.",
                "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 1},
                "similarity": 0.93,
                "retrieval_score": 0.93,
            }]

        def run(index):
            return agentic_retrieve(
                query=query,
                user_id="user-1",
                project_space_id="space-1",
                conversation_id=f"conversation-{index}",
                retrieve_fn=fake_retrieve,
                cache_store=cache,
            )

        with ThreadPoolExecutor(max_workers=20) as executor:
            results = list(executor.map(run, range(20)))

        self.assertEqual(retrieve_calls, len(plan_queries(query, max_queries=3)))
        self.assertTrue(all(result["results"][0]["id"] == "chunk-oauth" for result in results))
        self.assertTrue(any(
            (result.get("cache") or {}).get("singleflight", {}).get("outcome") == "coalesced_hit"
            for result in results
        ))

    def test_agentic_retrieve_ignores_cached_evidence_when_scope_fingerprint_changes(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v2")
        query = "How does OAuth refresh token rotation work?"
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="how does oauth refresh token rotation work?",
            original_query="How does OAuth refresh token rotation work?",
            scope_fingerprint=self._cache_scope("scope-v1", query),
            documents=[
                {
                    "id": "chunk-stale",
                    "content": "Stale OAuth evidence from an older knowledge version.",
                    "metadata": {"filename": "old-auth.md", "file_id": "file-old", "chunk_index": 0},
                    "similarity": 0.99,
                    "retrieval_score": 0.99,
                }
            ],
            quality={"overall_score": 0.95, "evidence_label": "strong"},
        )

        retrieve_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(query)
            return [{
                "id": "chunk-fresh",
                "content": "Fresh OAuth refresh token rotation evidence from the current knowledge version.",
                "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 2},
                "similarity": 0.88,
                "retrieval_score": 0.88,
            }]

        result = agentic_retrieve(
            query=query,
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertGreater(len(retrieve_calls), 0)
        self.assertEqual(result["results"][0]["id"], "chunk-fresh")
        self.assertNotEqual(result["cache"]["status"], "hit")

    def test_agentic_retrieve_supplements_cached_evidence_when_confidence_is_weak(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        query = "How does OAuth refresh token rotation work?"
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="how does oauth refresh token rotation work?",
            original_query="How does OAuth refresh token rotation work?",
            scope_fingerprint=self._cache_scope("scope-v1", query),
            documents=[
                {
                    "id": "chunk-weak-cache",
                    "content": "Account settings mention sessions.",
                    "metadata": {"filename": "profile.md", "file_id": "file-profile", "chunk_index": 0},
                    "similarity": 0.2,
                    "retrieval_score": 0.2,
                }
            ],
            quality={"overall_score": 0.2, "evidence_label": "weak"},
        )

        retrieve_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(query)
            return [{
                "id": "chunk-fresh-oauth",
                "content": "OAuth refresh token rotation revokes the previous token and issues a new HttpOnly refresh session.",
                "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 3},
                "similarity": 0.9,
                "retrieval_score": 0.9,
            }]

        result = agentic_retrieve(
            query=query,
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertGreater(len(retrieve_calls), 0)
        self.assertEqual(result["results"][0]["id"], "chunk-fresh-oauth")
        self.assertNotIn("chunk-weak-cache", [document["id"] for document in result["results"]])
        reuse_steps = [step for step in result["trace_steps"] if step["step_type"] == "evidence_reuse"]
        self.assertEqual(reuse_steps[0]["status"], "partial")
        self.assertEqual(result["cache"]["status"], "partial")

    def test_agentic_retrieve_verifies_cached_evidence_before_skipping_retrieval(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        query = "Must API v2.4 use a 250ms or 500ms timeout?"
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query=query,
            original_query=query,
            scope_fingerprint=self._cache_scope("scope-v1", query, limit=3),
            documents=[
                {
                    "id": "cached-default-timeout",
                    "content": "API v2.4 currently documents a 500ms timeout.",
                    "metadata": {"filename": "api-overview.md", "file_id": "overview", "chunk_index": 1},
                    "similarity": 0.99,
                    "retrieval_score": 0.99,
                }
            ],
            quality={"overall_score": 0.92, "evidence_label": "strong"},
        )

        retrieve_calls = []

        def fake_retrieve(planned_query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(planned_query)
            return [{
                "id": "fresh-versioned-timeout",
                "content": "API v2.4 must use a 250ms timeout and must not use the legacy 500ms timeout.",
                "metadata": {"filename": "api-reference.md", "file_id": "reference", "chunk_index": 4},
                "similarity": 0.86,
                "retrieval_score": 0.86,
            }]

        result = agentic_retrieve(
            query=query,
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            limit=3,
            threshold=0.1,
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertGreater(len(retrieve_calls), 0)
        self.assertEqual(result["cache"]["status"], "partial")
        self.assertEqual(result["results"][0]["id"], "fresh-versioned-timeout")
        self.assertIn("support_label", result["quality"])
        self.assertEqual(result["quality"]["support_label"], "supported")
        step_types = [step["step_type"] for step in result["trace_steps"]]
        self.assertIn("risk_assess", step_types)
        self.assertIn("evidence_verify", step_types)

    def test_agentic_retrieve_reuses_subquery_cache_for_planned_queries(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        query = "How does OAuth refresh token rotation work?"
        cached_subquery = plan_queries(query, max_queries=3)[1]
        cache.upsert_subquery_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query=cached_subquery,
            original_query=cached_subquery,
            scope_fingerprint=self._cache_scope(
                "scope-v1",
                query,
                limit=4,
            ),
            documents=[
                {
                    "id": "chunk-cached-oauth",
                    "content": "OAuth refresh token rotation invalidates the previous token and issues a new HttpOnly session.",
                    "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 1},
                    "similarity": 0.82,
                    "retrieval_score": 0.82,
                }
            ],
            quality={"overall_score": 0.7, "evidence_label": "strong"},
        )

        retrieve_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(query)
            return [{
                "id": f"chunk-live-{len(retrieve_calls)}",
                "content": "The worker retries failed requests with bounded backoff.",
                "metadata": {"filename": "worker.md", "file_id": "file-worker", "chunk_index": len(retrieve_calls)},
                "similarity": 0.74,
                "retrieval_score": 0.74,
            }]

        result = agentic_retrieve(
            query=query,
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            limit=4,
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertLess(len(retrieve_calls), len(result["planned_queries"]))
        self.assertTrue(any(document["id"] == "chunk-cached-oauth" for document in result["results"]))
        step_types = [step["step_type"] for step in result["trace_steps"]]
        self.assertIn("subquery_cache_hit", step_types)

    def test_plan_queries_deduplicates_and_keeps_original_first(self):
        queries = plan_queries("  How does OAuth login handle refresh tokens?  ", max_queries=3)

        self.assertGreaterEqual(len(queries), 1)
        self.assertLessEqual(len(queries), 3)
        self.assertEqual(queries[0], "How does OAuth login handle refresh tokens?")
        self.assertEqual(len(queries), len(set(queries)))
        self.assertTrue(all(query.strip() for query in queries))

    def test_plan_queries_extracts_useful_terms_from_chinese_question_phrases(self):
        queries = plan_queries("消息队列如何保证消费可靠性？", max_queries=3)

        self.assertEqual(queries[0], "消息队列如何保证消费可靠性？")
        self.assertIn("消息队列 保证消费可靠性", queries)

    def test_follow_up_query_carries_previous_user_question_into_retrieval(self):
        resolution = resolve_standalone_query(
            "那它失败以后呢？",
            [
                {"role": "user", "content": "Redis 如何保证消息可靠性？"},
                {"role": "assistant", "content": "它可以使用持久化和确认机制。"},
            ],
        )

        self.assertTrue(resolution["context_dependent"])
        self.assertEqual(resolution["resolution_method"], "previous_user_turn_context")
        self.assertIn("Redis 如何保证消息可靠性", resolution["standalone_query"])
        self.assertIn("失败以后", resolution["standalone_query"])

    def test_standalone_question_does_not_absorb_unrelated_conversation_history(self):
        resolution = resolve_standalone_query(
            "PostgreSQL 的 WAL 有什么作用？",
            [{"role": "user", "content": "Redis 如何保证消息可靠性？"}],
        )

        self.assertFalse(resolution["context_dependent"])
        self.assertEqual(resolution["standalone_query"], "PostgreSQL 的 WAL 有什么作用？")

    def test_short_question_with_explicit_subject_does_not_absorb_history(self):
        resolution = resolve_standalone_query(
            "Redis 有限制吗？",
            [{"role": "user", "content": "PostgreSQL 的 WAL 有什么作用？"}],
        )

        self.assertFalse(resolution["context_dependent"])
        self.assertEqual(resolution["standalone_query"], "Redis 有限制吗？")

    def test_multi_turn_elliptical_follow_up_keeps_the_nearest_standalone_topic(self):
        resolution = resolve_standalone_query(
            "如果文件损坏怎么办？",
            [
                {"role": "user", "content": "Redis 的 AOF 如何持久化？"},
                {"role": "assistant", "content": "AOF 会追加写命令。"},
                {"role": "user", "content": "第二种策略呢？"},
                {"role": "assistant", "content": "可以按秒同步。"},
            ],
        )

        self.assertTrue(resolution["context_dependent"])
        self.assertEqual(resolution["context_turns_used"], 2)
        self.assertIn("Redis 的 AOF", resolution["standalone_query"])
        self.assertIn("第二种策略", resolution["standalone_query"])
        self.assertIn("文件损坏", resolution["standalone_query"])

    def test_comparison_follow_up_is_context_dependent_even_with_a_named_comparator(self):
        resolution = resolve_standalone_query(
            "和 RabbitMQ 相比有什么区别？",
            [{"role": "user", "content": "Redis Streams 如何确认消费？"}],
        )

        self.assertTrue(resolution["context_dependent"])
        self.assertIn("Redis Streams", resolution["standalone_query"])
        self.assertIn("RabbitMQ", resolution["standalone_query"])

    def test_agentic_retrieval_uses_resolved_follow_up_for_backend_queries(self):
        calls = []

        def retrieve(query, user_id, project_space_id, limit, threshold, routes=None):
            calls.append(query)
            return [{
                "id": "chunk-1",
                "content": "Redis failure recovery uses persisted state and retry handling.",
                "metadata": {"filename": "redis.md", "file_id": "file-1", "chunk_index": 0},
                "retrieval_score": 1.0,
            }]

        result = agentic_retrieve(
            "那它失败以后呢？",
            "user-1",
            conversation_context=[
                {"role": "user", "content": "Redis 如何保证消息可靠性？"},
                {"role": "assistant", "content": "它使用确认和持久化机制。"},
            ],
            retrieve_fn=retrieve,
            rerank_fn=lambda _query, documents: documents,
            cache_store=None,
        )

        self.assertTrue(calls)
        self.assertIn("Redis", calls[0])
        self.assertTrue(all(query != "那它失败以后呢？" for query in calls))
        self.assertEqual(result["query_resolution"]["resolution_method"], "previous_user_turn_context")
        self.assertEqual(result["trace_steps"][0]["step_type"], "conversation_query_resolve")

    def test_planned_query_misses_run_with_bounded_parallelism(self):
        lock = threading.Lock()
        release = threading.Event()
        entered = 0

        def retrieve(query, user_id, project_space_id, limit, threshold, routes=None):
            nonlocal entered
            with lock:
                entered += 1
                if entered >= 2:
                    release.set()
            if not release.wait(timeout=1):
                raise RuntimeError("planned queries ran serially")
            return [{
                "id": f"chunk-{entered}",
                "content": "OAuth refresh token rotation invalidates the previous token.",
                "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": entered},
                "retrieval_score": 0.9,
            }]

        result = agentic_retrieve(
            "How does OAuth refresh token rotation work?",
            "user-1",
            retrieve_fn=retrieve,
            rerank_fn=lambda _query, documents: documents,
        )

        retrieve_steps = [step for step in result["trace_steps"] if step["step_type"] == "retrieve"]
        self.assertGreaterEqual(entered, 2)
        self.assertTrue(all(step["status"] != "failed" for step in retrieve_steps))
        self.assertTrue(all(step["output"]["parallelism"] >= 2 for step in retrieve_steps))

    def test_ranked_children_expand_to_bounded_markdown_parent_sections(self):
        child = {
            "id": "child-2",
            "content": "Refresh rotation invalidates the previous token.",
            "metadata": {
                "filename": "auth.md",
                "file_id": "file-auth",
                "chunk_index": 2,
                "heading_path": ["Authentication", "Rotation"],
                "parent_section_id": "section-rotation",
            },
            "retrieval_score": 0.9,
        }
        parent_calls = []

        def parent_depth(user_id, project_space_id, matches, max_parents, max_chunks):
            parent_calls.append((user_id, project_space_id, [item["id"] for item in matches], max_parents, max_chunks))
            return [
                {**child, "content": "## Rotation\nRefresh tokens are single use.", "chunk_index": 1},
                {**child, "id": "child-2", "content": "## Rotation\nRefresh rotation invalidates the previous token.", "chunk_index": 2},
            ]

        result = agentic_retrieve(
            "How does refresh token rotation work?",
            "user-1",
            retrieve_fn=lambda *_args: [child],
            rerank_fn=lambda _query, documents: documents,
            parent_depth_fn=parent_depth,
        )

        self.assertEqual(parent_calls, [("user-1", None, ["child-2"], 8, 6)])
        self.assertEqual(result["results"][0]["id"], "parent:file-auth:section-rotation")
        self.assertIn("Refresh tokens are single use.", result["results"][0]["content"])
        parent_trace = next(step for step in result["trace_steps"] if step["step_type"] == "parent_expand")
        self.assertEqual(parent_trace["output"]["expanded_parent_count"], 1)

    def test_plan_queries_preserves_exact_domain_markers_in_focused_variants(self):
        queries = plan_queries("华东 E-2 紧急等级下，响应确认窗口应按 T+5 还是 T+3？", max_queries=3)

        self.assertEqual(queries[0], "华东 E-2 紧急等级下，响应确认窗口应按 T+5 还是 T+3？")
        self.assertTrue(any("E-2" in query and "T+5" in query and "T+3" in query for query in queries[1:]))

    def test_plan_queries_preserves_short_regulatory_acronyms(self):
        queries = plan_queries("CN 患者原始诊疗文本是否能在事故恢复期间同步到 EU 分析域，并由 AI 服务处理？", max_queries=3)

        focused_variants = " ".join(queries[1:])
        self.assertIn("CN", focused_variants)
        self.assertIn("EU", focused_variants)
        self.assertIn("AI", focused_variants)

    def test_agentic_retrieve_records_trace_and_scores_selected_sources(self):
        calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            calls.append({
                "query": query,
                "user_id": user_id,
                "project_space_id": project_space_id,
                "limit": limit,
                "threshold": threshold,
            })
            return [
                {
                    "id": "chunk-oauth",
                    "content": "OAuth login exchanges a GitHub code and refresh tokens rotate HttpOnly sessions.",
                    "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 2},
                    "similarity": 0.91,
                },
                {
                    "id": "chunk-general",
                    "content": "General account settings can be updated from the profile page.",
                    "metadata": {"filename": "profile.md", "file_id": "file-profile", "chunk_index": 1},
                    "similarity": 0.42,
                },
            ]

        result = agentic_retrieve(
            query="How does OAuth login handle refresh tokens?",
            user_id="user-1",
            project_space_id="space-1",
            limit=3,
            threshold=0.1,
            retrieve_fn=fake_retrieve,
        )

        self.assertTrue(result["run_id"])
        self.assertEqual(result["mode"], "agentic")
        self.assertEqual(len(calls), len(result["planned_queries"]))
        self.assertLessEqual(len(result["results"]), 3)
        self.assertEqual(result["results"][0]["id"], "chunk-oauth")

        step_types = [step["step_type"] for step in result["trace_steps"]]
        self.assertIn("query_rewrite", step_types)
        self.assertIn("retrieve", step_types)
        self.assertIn("rerank", step_types)
        self.assertIn("evidence_check", step_types)

        quality = result["quality"]
        self.assertGreaterEqual(quality["overall_score"], 0)
        self.assertLessEqual(quality["overall_score"], 1)
        self.assertGreater(quality["retrieval_score"], 0)
        self.assertGreater(quality["citation_score"], 0)
        self.assertIn(quality["evidence_label"], {"strong", "partial", "weak"})

    def test_agentic_retrieve_accepts_reranker_and_flags_insufficient_evidence(self):
        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            return [
                {
                    "id": "chunk-weak",
                    "content": "Billing settings and account avatars live on the profile page.",
                    "metadata": {"filename": "profile.md", "file_id": "file-profile", "chunk_index": 1},
                    "similarity": 0.12,
                },
                {
                    "id": "chunk-better",
                    "content": "OAuth refresh token rotation is described in the authentication operations guide.",
                    "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 4},
                    "similarity": 0.52,
                },
            ]

        def fake_rerank(query, documents):
            reranked = list(reversed(documents))
            for index, document in enumerate(reranked):
                document["rerank_score"] = 1 - index * 0.1
            return reranked

        result = agentic_retrieve(
            query="How does OAuth refresh token rotation work?",
            user_id="user-1",
            project_space_id="space-1",
            limit=1,
            threshold=0.1,
            retrieve_fn=fake_retrieve,
            rerank_fn=fake_rerank,
        )

        self.assertEqual(result["results"][0]["id"], "chunk-better")
        self.assertIn("insufficient_evidence", result)
        self.assertIn("answer_guidance", result)
        self.assertIsInstance(result["insufficient_evidence"], bool)
        self.assertIn("rerank_score", result["results"][0])

        rerank_steps = [step for step in result["trace_steps"] if step["step_type"] == "rerank"]
        self.assertEqual(rerank_steps[-1]["output"]["reranker"], "custom")

    def test_agentic_retrieve_default_rerank_uses_named_reranker(self):
        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            return [{
                "id": "chunk-1",
                "content": "JSBridge connects WebView and Native runtime.",
                "metadata": {"filename": "webview.md", "file_id": "file-1", "chunk_index": 0},
                "similarity": 0.8,
                "retrieval_score": 0.8,
            }]

        result = agentic_retrieve(
            query="JSBridge WebView Native",
            user_id="user-1",
            project_space_id="space-1",
            retrieve_fn=fake_retrieve,
        )

        rerank_steps = [step for step in result["trace_steps"] if step["step_type"] == "rerank"]
        self.assertEqual(rerank_steps[-1]["output"]["reranker"], "local-evidence-v2")
        self.assertEqual(result["results"][0]["reranker"], "local-evidence-v2")
        self.assertGreater(result["results"][0]["agentic_score"], 0)

    def test_agentic_retrieve_records_question_classification_and_route(self):
        routed_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold, routes=None):
            routed_calls.append(routes)
            return [{
                "id": "chunk-graph",
                "content": "JSBridge connects WebView and Native runtime.",
                "metadata": {"filename": "webview.md", "file_id": "file-1", "chunk_index": 0},
                "similarity": 0.8,
                "retrieval_score": 0.8,
                "retrieval_channels": ["vector", "bm25", "graph"],
            }]

        result = agentic_retrieve(
            query="JSBridge 和 WebView 有什么关系？",
            user_id="user-1",
            project_space_id="space-1",
            retrieve_fn=fake_retrieve,
        )

        step_types = [step["step_type"] for step in result["trace_steps"]]
        self.assertIn("question_classify", step_types)
        self.assertIn("retriever_route", step_types)
        route_step = [step for step in result["trace_steps"] if step["step_type"] == "retriever_route"][0]
        self.assertEqual(route_step["output"]["routes"], ["vector", "bm25", "graph"])
        self.assertEqual(result["intent"]["type"], "relationship")
        self.assertTrue(routed_calls)
        self.assertTrue(all(routes == ["vector", "bm25", "graph"] for routes in routed_calls))

    def test_agentic_retrieve_records_retrieval_channel_summary_in_trace(self):
        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            return RetrievalDocuments([
                {
                    "id": "chunk-hybrid",
                    "content": "JSBridge connects WebView and Native runtime through a bridge contract.",
                    "metadata": {
                        "filename": "webview.md",
                        "file_id": "file-webview",
                        "chunk_index": 0,
                        "retrieval_mode": "hybrid_rrf",
                        "retrieval_channels": ["vector", "bm25", "graph"],
                    },
                    "similarity": 0.91,
                    "retrieval_score": 0.91,
                    "retrieval_channels": ["vector", "bm25", "graph"],
                },
                {
                    "id": "chunk-lexical",
                    "content": "WebView fallback notes mention JSBridge setup.",
                    "metadata": {
                        "filename": "fallback.md",
                        "file_id": "file-fallback",
                        "chunk_index": 1,
                        "retrieval_mode": "lexical",
                        "retrieval_channels": ["bm25"],
                    },
                    "similarity": 0.5,
                    "retrieval_score": 0.5,
                    "retrieval_channels": ["bm25"],
                },
            ], {"vector": "error", "bm25": "ok", "graph": "ok"})

        result = agentic_retrieve(
            query="JSBridge 和 WebView 有什么关系？",
            user_id="user-1",
            project_space_id="space-1",
            retrieve_fn=fake_retrieve,
        )

        retrieve_steps = [step for step in result["trace_steps"] if step["step_type"] == "retrieve"]
        self.assertGreater(len(retrieve_steps), 0)
        summary = retrieve_steps[0]["output"]
        self.assertEqual(summary["channel_counts"]["bm25"], 2)
        self.assertEqual(summary["channel_counts"]["vector"], 1)
        self.assertEqual(summary["channel_counts"]["graph"], 1)
        self.assertEqual(summary["mode_counts"]["hybrid_rrf"], 1)
        self.assertEqual(summary["mode_counts"]["lexical"], 1)
        self.assertEqual(summary["unique_source_count"], 2)
        self.assertEqual(summary["channel_status"]["vector"], "error")
        self.assertTrue(summary["degraded"])
        self.assertEqual(retrieve_steps[0]["status"], "partial")

    def test_agentic_retrieve_routes_comparison_questions_without_graph(self):
        routed_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold, routes=None):
            routed_calls.append(routes)
            return [{
                "id": "chunk-drift",
                "content": "模型漂移在 AI 质控、医保风控和 SRE 观测中的含义不同。",
                "metadata": {"filename": "observability.md", "file_id": "file-1", "chunk_index": 0},
                "similarity": 0.8,
                "retrieval_score": 0.8,
            }]

        result = agentic_retrieve(
            query="模型漂移一词在 AI 质控、医保风控和 SRE 观测中如何区分？",
            user_id="user-1",
            project_space_id="space-1",
            retrieve_fn=fake_retrieve,
        )

        self.assertEqual(result["intent"]["type"], "comparison")
        route_step = [step for step in result["trace_steps"] if step["step_type"] == "retriever_route"][0]
        self.assertEqual(route_step["output"]["routes"], ["vector", "bm25"])
        self.assertTrue(routed_calls)
        self.assertTrue(all(routes == ["vector", "bm25"] for routes in routed_calls))

    def test_capability_question_does_not_treat_support_as_graph_relation(self):
        intent = _classify_question("Redis 支持哪些数据类型？")

        self.assertEqual(intent["type"], "knowledge_qa")
        self.assertEqual(intent["routes"], ["vector", "bm25"])

    def test_relational_database_category_does_not_route_to_graph(self):
        intent = _classify_question("PostgreSQL 是关系型数据库吗？")

        self.assertEqual(intent["type"], "knowledge_qa")
        self.assertEqual(intent["routes"], ["vector", "bm25"])

    def test_graph_route_matches_collaboration_and_ontology_relationships(self):
        collaboration = _classify_question("Worker 和 Queue 如何协作？")
        usage = _classify_question("Which service uses Redis?")

        self.assertEqual(collaboration["type"], "relationship")
        self.assertIn("graph", collaboration["routes"])
        self.assertEqual(usage["type"], "relationship")
        self.assertIn("graph", usage["routes"])

    def test_direct_single_hop_ontology_questions_route_to_graph(self):
        queries = (
            "订单服务使用 Redis 吗？",
            "张伟负责付款审批吗？",
            "供应商向客户提供服务吗？",
            "甲方向乙方支付服务费了吗？",
            "合同由张伟签署吗？",
            "Which team is responsible for approvals?",
            "Does Supplier provide support to Customer?",
            "Who paid the service fee?",
        )

        for query in queries:
            with self.subTest(query=query):
                intent = _classify_question(query)
                self.assertEqual(intent["type"], "relationship")
                self.assertEqual(intent["routes"], ["vector", "bm25", "graph"])

    def test_agentic_retrieve_retries_when_initial_candidates_do_not_support_query(self):
        calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold, routes=None):
            calls.append((query, routes))
            if "related context" not in query:
                return [{
                    "id": "noise",
                    "content": "Account profile colors can be customized.",
                    "metadata": {"filename": "profile.md", "file_id": "profile", "chunk_index": 0},
                    "similarity": 0.8,
                    "retrieval_score": 0.8,
                }]
            return [{
                "id": "chunk-retry",
                "content": "Expanded retrieval found the WebView JSBridge notes.",
                "metadata": {"filename": "webview.md", "file_id": "file-1", "chunk_index": 1},
                "similarity": 0.7,
                "retrieval_score": 0.7,
            }]

        result = agentic_retrieve(
            query="JSBridge",
            user_id="user-1",
            project_space_id="space-1",
            retrieve_fn=fake_retrieve,
        )

        self.assertGreaterEqual(len(calls), 2)
        self.assertTrue(all(routes == ["vector", "bm25"] for _, routes in calls))
        self.assertEqual(result["results"][0]["id"], "chunk-retry")
        retry_steps = [step for step in result["trace_steps"] if step["step_type"] == "retrieve_retry"]
        self.assertEqual(retry_steps[-1]["status"], "success")
        self.assertIn("unsupported_candidates", retry_steps[-1]["input"]["reasons"])

    def test_agentic_retrieve_routes_uploaded_document_inventory_to_metadata_lookup(self):
        retrieve_calls = []
        inventory_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(query)
            return []

        def fake_inventory(user_id, project_space_id, limit):
            inventory_calls.append({
                "user_id": user_id,
                "project_space_id": project_space_id,
                "limit": limit,
            })
            return [
                {
                    "id": "file-intro",
                    "filename": "0-小册介绍.md",
                    "file_size": 2048,
                    "status": "completed",
                    "created_at": "2026-07-05T10:00:00Z",
                    "updated_at": "2026-07-05T10:01:00Z",
                },
                {
                    "id": "file-webview",
                    "filename": "2-WebView 原理篇：核心架构设计.md",
                    "file_size": 4096,
                    "status": "completed",
                    "created_at": "2026-07-05T10:02:00Z",
                    "updated_at": "2026-07-05T10:03:00Z",
                },
            ]

        result = agentic_retrieve(
            query="告诉我现在知识库里面上传了些什么内容？",
            user_id="user-1",
            project_space_id="space-1",
            limit=5,
            threshold=0.1,
            retrieve_fn=fake_retrieve,
            inventory_fn=fake_inventory,
        )

        self.assertEqual(retrieve_calls, [])
        self.assertEqual(inventory_calls, [{
            "user_id": "user-1",
            "project_space_id": "space-1",
            "limit": 100,
        }])
        self.assertEqual(result["mode"], "metadata_inventory")
        self.assertEqual(len(result["results"]), 2)
        self.assertIn("0-小册介绍.md", result["results"][0]["content"])
        self.assertEqual(result["results"][0]["metadata"]["retrieval_mode"], "metadata_inventory")
        self.assertEqual(result["quality"]["evidence_label"], "strong")

        step_types = [step["step_type"] for step in result["trace_steps"]]
        self.assertEqual(step_types, [
            "conversation_query_resolve",
            "intent_route",
            "metadata_lookup",
            "evidence_check",
        ])

    def test_agentic_retrieve_uses_exact_inventory_count_and_reports_truncation(self):
        retrieve_calls = []
        inventory_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(query)
            return []

        def fake_inventory(user_id, project_space_id, limit):
            inventory_calls.append(limit)
            return [
                {
                    "id": f"file-{index}",
                    "filename": f"{index:02d}-document.md",
                    "file_size": 1024,
                    "status": "completed",
                    "created_at": "2026-07-05T10:00:00Z",
                    "updated_at": "2026-07-05T10:01:00Z",
                }
                for index in range(1, 31)
            ]

        result = agentic_retrieve(
            query="知识库里面一共有几篇文档？把上传的文档都列出来。",
            user_id="user-1",
            project_space_id="space-1",
            limit=5,
            threshold=0.1,
            retrieve_fn=fake_retrieve,
            inventory_fn=fake_inventory,
            inventory_count_fn=lambda _user_id, _project_space_id: 735,
        )

        self.assertEqual(retrieve_calls, [])
        self.assertEqual(inventory_calls, [100])
        self.assertEqual(result["mode"], "metadata_inventory")
        self.assertEqual(result["inventory_total"], 735)
        self.assertEqual(result["inventory_returned"], 30)
        self.assertTrue(result["inventory_truncated"])
        self.assertEqual(len(result["results"]), 30)
        self.assertIn("735 篇", result["answer_guidance"])
        self.assertIn("清单已截断", result["answer_guidance"])

    def test_agentic_retrieve_routes_plain_document_count_questions_to_full_inventory(self):
        retrieve_calls = []
        inventory_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(query)
            return []

        def fake_inventory(user_id, project_space_id, limit):
            inventory_calls.append(limit)
            return [
                {
                    "id": f"file-{index}",
                    "filename": f"doc-{index}.md",
                    "file_size": 1024,
                    "status": "completed",
                    "created_at": "2026-07-05T10:00:00Z",
                    "updated_at": "2026-07-05T10:01:00Z",
                }
                for index in range(1, 19)
            ]

        result = agentic_retrieve(
            query="知识库里面有多少文档？",
            user_id="user-1",
            project_space_id="space-1",
            limit=5,
            threshold=0.1,
            retrieve_fn=fake_retrieve,
            inventory_fn=fake_inventory,
        )

        self.assertEqual(retrieve_calls, [])
        self.assertEqual(inventory_calls, [100])
        self.assertEqual(result["mode"], "metadata_inventory")
        self.assertEqual(result["inventory_total"], 18)
        self.assertEqual(len(result["results"]), 18)

    def test_agentic_retrieve_does_not_treat_document_title_list_as_inventory_request(self):
        retrieve_calls = []
        inventory_calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(query)
            return [{
                "id": "chunk-handoff",
                "content": "联调资料移交清单 的核心内容包括资料流转、证据状态、责任部门和并读限制。",
                "metadata": {"filename": "联调资料移交清单.md", "file_id": "file-handoff", "chunk_index": 0},
                "similarity": 0.9,
                "retrieval_score": 0.9,
            }]

        def fake_inventory(user_id, project_space_id, limit):
            inventory_calls.append(limit)
            return []

        result = agentic_retrieve(
            query="请基于知识库原文概述《联调资料移交清单》的核心内容、关键限制和需要并读的证据。",
            user_id="user-1",
            project_space_id="space-1",
            limit=5,
            threshold=0.1,
            retrieve_fn=fake_retrieve,
            inventory_fn=fake_inventory,
        )

        self.assertEqual(result["mode"], "agentic")
        self.assertEqual(inventory_calls, [])
        self.assertGreater(len(retrieve_calls), 0)
        self.assertEqual(result["results"][0]["metadata"]["filename"], "联调资料移交清单.md")

    def test_agentic_retrieve_does_not_route_document_content_questions_to_inventory(self):
        content_questions = (
            "请基于知识库文档回答：旧政策截图有什么用？",
            "请基于知识库文档回答：可赔停线和事实停线有什么区别？",
            "请基于知识库文档回答：FW-4.7.9 的已知问题有哪些？",
            "请基于知识库文档回答：审计证据链包含哪些项？",
            "请基于知识库文档回答：FW-4.8.2 新增哪些诊断字段？",
            "上传的文档有什么合规要求？",
            "请列出上传文件，并总结当前政策。",
        )

        for question in content_questions:
            with self.subTest(question=question):
                retrieve_calls = []
                inventory_calls = []

                def fake_retrieve(query, user_id, project_space_id, limit, threshold):
                    retrieve_calls.append(query)
                    return [{
                        "id": "content-chunk",
                        "content": "这是问题对应的正式原文证据。",
                        "metadata": {"filename": "正式证据.md", "file_id": "evidence", "chunk_index": 1},
                        "similarity": 0.9,
                        "retrieval_score": 0.9,
                    }]

                def fake_inventory(user_id, project_space_id, limit):
                    inventory_calls.append(limit)
                    return []

                result = agentic_retrieve(
                    query=question,
                    user_id="user-1",
                    project_space_id="space-1",
                    limit=5,
                    threshold=0.1,
                    retrieve_fn=fake_retrieve,
                    inventory_fn=fake_inventory,
                )

                self.assertEqual(result["mode"], "agentic")
                self.assertEqual(inventory_calls, [])
                self.assertGreater(len(retrieve_calls), 0)

    def test_evaluate_retrieval_quality_is_bounded_for_empty_results(self):
        quality = evaluate_retrieval_quality("missing deployment notes", [])

        self.assertEqual(quality["retrieval_score"], 0)
        self.assertEqual(quality["citation_score"], 0)
        self.assertEqual(quality["evidence_score"], 0)
        self.assertEqual(quality["overall_score"], 0)
        self.assertEqual(quality["evidence_label"], "weak")

    def test_evaluate_retrieval_quality_does_not_mark_missing_exact_marker_as_strong(self):
        documents = [
            {
                "id": "generic-sample-table",
                "content": "质保暂挂需要同时看保险查勘、技术报告和服务站记录，但本段没有出现具体样本号。",
                "metadata": {"filename": "售后专项材料目录.md", "file_id": "directory", "chunk_index": 5},
                "agentic_score": 0.88,
                "source_role": "primary",
            },
            {
                "id": "generic-legal",
                "content": "费用暂挂不能被解释成根因确认，证据链需要保留限定语。",
                "metadata": {"filename": "法务风险备忘录.md", "file_id": "legal", "chunk_index": 2},
                "agentic_score": 0.82,
                "source_role": "primary",
            },
        ]

        quality = evaluate_retrieval_quality("A-031 样本为什么被质保暂挂？需要同时看哪些证据？", documents)

        self.assertLess(quality["exact_marker_coverage"], 1)
        self.assertNotEqual(quality["evidence_label"], "strong")

    def test_hybrid_retrieval_falls_back_to_lexical_when_embedding_fails(self):
        lexical_chunk = {
            "id": "chunk-lexical",
            "file_id": "file-auth",
            "user_id": "user-1",
            "chunk_index": 1,
            "content": "OAuth refresh token rotation keeps sessions secure.",
            "metadata": {"filename": "auth.md"},
            "project_space_id": "space-1",
            "filename": "auth.md",
            "lexical_score": 0.8,
        }

        with patch("retrieval.get_embedding", side_effect=RuntimeError("embedding quota exhausted")):
            with patch("retrieval.search_chunks_by_text", return_value=[lexical_chunk]):
                documents = retrieve_documents(
                    query="OAuth refresh token rotation",
                    user_id="user-1",
                    project_space_id="space-1",
                    limit=1,
                    threshold=0.1,
                )

        self.assertEqual(documents[0]["id"], "chunk-lexical")
        self.assertEqual(documents[0]["metadata"]["retrieval_mode"], "lexical")
        self.assertEqual(documents[0]["vector_similarity"], 0)
        self.assertGreater(documents[0]["lexical_score"], 0)


if __name__ == "__main__":
    unittest.main()

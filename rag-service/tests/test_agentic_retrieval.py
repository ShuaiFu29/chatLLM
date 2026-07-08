import unittest
from pathlib import Path
from unittest.mock import patch

from agentic_retrieval import agentic_retrieve
from evaluation import evaluate_retrieval_quality
from query_planner import plan_queries
from retrieval_cache import InMemoryRetrievalCache
from retrieval import retrieve_documents

ROOT = Path(__file__).resolve().parents[1]


class AgenticRetrievalTests(unittest.TestCase):
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
        self.assertIn("cache write timeout", cache_write_steps[-1]["output"]["error"])

    def test_agentic_retrieve_reports_cache_hit_side_effect_failure_without_retrieving(self):
        class FailingHitCache(InMemoryRetrievalCache):
            def record_hit(self, entry):
                raise RuntimeError("hit counter unavailable")

        cache = FailingHitCache(scope_fingerprint="scope-v1")
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="how does oauth refresh token rotation work?",
            original_query="How does OAuth refresh token rotation work?",
            scope_fingerprint="scope-v1",
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
            query="How does OAuth refresh token rotation work?",
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
        self.assertIn("hit counter unavailable", cache_side_effect_steps[-1]["output"]["error"])

    def test_agentic_retrieve_reuses_exact_cached_evidence_without_retrieving(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="how does oauth refresh token rotation work?",
            original_query="How does OAuth refresh token rotation work?",
            scope_fingerprint="scope-v1",
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
            query="How does OAuth refresh token rotation work?",
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

    def test_agentic_retrieve_ignores_cached_evidence_when_scope_fingerprint_changes(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v2")
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="how does oauth refresh token rotation work?",
            original_query="How does OAuth refresh token rotation work?",
            scope_fingerprint="scope-v1",
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
            query="How does OAuth refresh token rotation work?",
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
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="how does oauth refresh token rotation work?",
            original_query="How does OAuth refresh token rotation work?",
            scope_fingerprint="scope-v1",
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
            query="How does OAuth refresh token rotation work?",
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertGreater(len(retrieve_calls), 0)
        self.assertEqual(result["results"][0]["id"], "chunk-fresh-oauth")
        reuse_steps = [step for step in result["trace_steps"] if step["step_type"] == "evidence_reuse"]
        self.assertEqual(reuse_steps[0]["status"], "partial")
        self.assertEqual(result["cache"]["status"], "partial")

    def test_agentic_retrieve_verifies_cached_evidence_before_skipping_retrieval(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        query = "华东 E-2 紧急等级下，响应确认窗口应按 T+5 还是 T+3？"
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query=query,
            original_query=query,
            scope_fingerprint="scope-v1",
            documents=[
                {
                    "id": "cached-default-rule",
                    "content": "2026 修订版规定默认响应确认窗口是 T+5 分钟，未说明华东 E-2 特例。",
                    "metadata": {"filename": "01-current.md", "file_id": "current", "chunk_index": 1},
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
                "id": "fresh-regional-rule",
                "content": "华东 E-2 紧急等级必须并读区域附件，响应确认窗口按 T+3，不能沿用默认 T+5。",
                "metadata": {"filename": "regional-appendix.md", "file_id": "regional", "chunk_index": 4},
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
        self.assertEqual(result["results"][0]["id"], "fresh-regional-rule")
        self.assertIn("support_label", result["quality"])
        self.assertEqual(result["quality"]["support_label"], "supported")
        step_types = [step["step_type"] for step in result["trace_steps"]]
        self.assertIn("risk_assess", step_types)
        self.assertIn("evidence_verify", step_types)

    def test_agentic_retrieve_supplements_single_source_cache_for_high_risk_cross_region_queries(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        query = "CN 患者原始诊疗文本是否能在事故恢复期间同步到 EU 分析域，并由 AI 服务处理？"
        cache.upsert_query_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query=query,
            original_query=query,
            scope_fingerprint="scope-v1",
            documents=[
                {
                    "id": "cached-single-policy",
                    "content": "CN 患者原始诊疗文本在事故恢复期间同步到 EU 分析域并由 AI 服务处理需要患者授权、跨境审批和审计留痕。",
                    "metadata": {"filename": "cn-eu-policy.md", "file_id": "policy", "chunk_index": 1},
                    "similarity": 0.99,
                    "retrieval_score": 0.99,
                }
            ],
            quality={"overall_score": 0.95, "evidence_label": "strong", "support_label": "supported"},
        )

        retrieve_calls = []

        def fake_retrieve(planned_query, user_id, project_space_id, limit, threshold):
            retrieve_calls.append(planned_query)
            return [
                {
                    "id": "fresh-cn-control",
                    "content": "CN 原始诊疗文本出境需要患者授权、出境安全评估和事故恢复期间的临时审批。",
                    "metadata": {"filename": "cn-control.md", "file_id": "cn", "chunk_index": 2},
                    "similarity": 0.88,
                    "retrieval_score": 0.88,
                },
                {
                    "id": "fresh-eu-ai-control",
                    "content": "EU 分析域由 AI 服务处理患者文本时必须启用目的限制、假名化和审计留痕。",
                    "metadata": {"filename": "eu-ai-control.md", "file_id": "eu", "chunk_index": 3},
                    "similarity": 0.84,
                    "retrieval_score": 0.84,
                },
            ]

        result = agentic_retrieve(
            query=query,
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            limit=4,
            threshold=0.1,
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertGreater(len(retrieve_calls), 0)
        self.assertEqual(result["cache"]["status"], "partial")
        verify_steps = [step for step in result["trace_steps"] if step["step_type"] == "evidence_verify"]
        self.assertIn("limited_source_diversity_for_high_risk_query", verify_steps[0]["output"]["reasons"])
        self.assertTrue(any(document["id"] == "fresh-cn-control" for document in result["results"]))

    def test_agentic_retrieve_reuses_subquery_cache_for_planned_queries(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        cache.upsert_subquery_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="模型重大变更 上线 双签 2024",
            original_query="模型重大变更 上线 双签 2024",
            scope_fingerprint="scope-v1",
            documents=[
                {
                    "id": "chunk-cached-model",
                    "content": "模型重大变更上线前需要完成双签，不得按 2024 旧口径补交。",
                    "metadata": {"filename": "model-change.md", "file_id": "file-model", "chunk_index": 1},
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
                "content": "患者授权和医保支付证据会影响模型重大变更上线审批。",
                "metadata": {"filename": "governance.md", "file_id": "file-gov", "chunk_index": len(retrieve_calls)},
                "similarity": 0.74,
                "retrieval_score": 0.74,
            }]

        result = agentic_retrieve(
            query="模型重大变更上线前是否必须完成双签，还是可以按 2024 口径补交？",
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            limit=4,
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertLess(len(retrieve_calls), len(result["planned_queries"]))
        self.assertTrue(any(document["id"] == "chunk-cached-model" for document in result["results"]))
        step_types = [step["step_type"] for step in result["trace_steps"]]
        self.assertIn("subquery_cache_hit", step_types)

    def test_agentic_retrieve_reports_partial_cache_status_when_subquery_cache_is_reused(self):
        cache = InMemoryRetrievalCache(scope_fingerprint="scope-v1")
        cached_document = {
            "id": "chunk-cached-model",
            "content": "模型重大变更上线前需要完成双签，不得按 2024 旧口径补交。",
            "metadata": {"filename": "model-change.md", "file_id": "file-model", "chunk_index": 1},
            "similarity": 0.82,
            "retrieval_score": 0.82,
        }
        cache.upsert_subquery_cache(
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            normalized_query="模型重大变更 上线 双签 2024",
            original_query="模型重大变更 上线 双签 2024",
            scope_fingerprint="scope-v1",
            documents=[cached_document],
            quality={"overall_score": 0.7, "evidence_label": "strong"},
        )

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            return [{
                "id": "chunk-live",
                "content": "患者授权和医保支付证据会影响模型重大变更上线审批。",
                "metadata": {"filename": "governance.md", "file_id": "file-gov", "chunk_index": 2},
                "similarity": 0.74,
                "retrieval_score": 0.74,
            }]

        result = agentic_retrieve(
            query="模型重大变更上线前是否必须完成双签，还是可以按 2024 口径补交？",
            user_id="user-1",
            project_space_id="space-1",
            conversation_id="conversation-1",
            limit=4,
            retrieve_fn=fake_retrieve,
            cache_store=cache,
        )

        self.assertEqual(result["cache"]["status"], "partial")
        self.assertEqual(result["cache"]["hit_type"], "subquery")
        self.assertGreaterEqual(result["cache"]["reused_count"], 1)

    def test_plan_queries_deduplicates_and_keeps_original_first(self):
        queries = plan_queries("  How does OAuth login handle refresh tokens?  ", max_queries=3)

        self.assertGreaterEqual(len(queries), 1)
        self.assertLessEqual(len(queries), 3)
        self.assertEqual(queries[0], "How does OAuth login handle refresh tokens?")
        self.assertEqual(len(queries), len(set(queries)))
        self.assertTrue(all(query.strip() for query in queries))

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
        self.assertEqual(rerank_steps[-1]["output"]["reranker"], "local-evidence")
        self.assertEqual(result["results"][0]["reranker"], "local-evidence")
        self.assertGreater(result["results"][0]["agentic_score"], 0)

    def test_agentic_retrieve_prefers_primary_evidence_over_eval_guides(self):
        documents = [
            {
                "id": "guide-1",
                "content": "RAG 压力测试知识库索引与评测指南。建议评测问题：2026 年默认响应确认窗口是多少？期望来源文档 01、02、11。",
                "metadata": {"filename": "00-corpus-index-and-test-guide.md", "file_id": "guide", "chunk_index": 1},
                "retrieval_score": 0.99,
            },
            {
                "id": "guide-2",
                "content": "评测时不要只看回答是否流畅，要检查引用是否命中正确文件。",
                "metadata": {"filename": "00-corpus-index-and-test-guide.md", "file_id": "guide", "chunk_index": 2},
                "retrieval_score": 0.98,
            },
            {
                "id": "deprecated-1",
                "content": "2025 试行版响应确认窗口为 T+7，但该规则已废止，仅用于历史复盘。",
                "metadata": {"filename": "02-deprecated.md", "file_id": "deprecated", "chunk_index": 1},
                "retrieval_score": 0.97,
            },
            {
                "id": "faq-1",
                "content": "FAQ 提醒 T+7 是历史口径，不能替代 2026 修订版正式规则。",
                "metadata": {"filename": "09-faq.md", "file_id": "faq", "chunk_index": 1},
                "retrieval_score": 0.96,
            },
            {
                "id": "current-1",
                "content": "2026 修订版当前总规则规定，默认响应确认窗口是 T+5 分钟。",
                "metadata": {"filename": "01-current.md", "file_id": "current", "chunk_index": 1},
                "retrieval_score": 0.5,
            },
        ]

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            return documents

        result = agentic_retrieve(
            query="2026 年默认响应确认窗口是多少？如果答案引用 T+7 是否正确？",
            user_id="user-1",
            project_space_id="space-1",
            limit=4,
            threshold=0,
            retrieve_fn=fake_retrieve,
        )

        selected_filenames = [document["metadata"]["filename"] for document in result["results"]]
        self.assertNotIn("00-corpus-index-and-test-guide.md", selected_filenames[:3])
        self.assertIn("01-current.md", selected_filenames)
        self.assertIn("02-deprecated.md", selected_filenames)
        self.assertTrue(all(document.get("agentic_score", 0) > 0 for document in result["results"]))
        self.assertEqual(result["quality"]["evidence_label"], "strong")

    def test_agentic_retrieve_records_question_classification_and_route(self):
        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
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
        self.assertIn("graph", route_step["output"]["routes"])
        self.assertEqual(result["intent"]["type"], "relationship")

    def test_agentic_retrieve_records_retrieval_channel_summary_in_trace(self):
        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            return [
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
            ]

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

    def test_agentic_retrieve_routes_distinction_questions_to_graph(self):
        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
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
        self.assertIn("graph", route_step["output"]["routes"])

    def test_agentic_retrieve_selects_cross_domain_facets_for_multi_hop_questions(self):
        documents = [
            {
                "id": "gov-1",
                "content": "治理总章程说明重大变更审批。",
                "metadata": {"filename": "01-governance.md", "file_id": "gov-1", "source_domain": "governance"},
                "similarity": 0.99,
                "retrieval_score": 0.99,
            },
            {
                "id": "gov-2",
                "content": "治理例外授权说明。",
                "metadata": {"filename": "02-governance.md", "file_id": "gov-2", "source_domain": "governance"},
                "similarity": 0.98,
                "retrieval_score": 0.98,
            },
            {
                "id": "model",
                "content": "模型重大变更需要影响评估和双签。",
                "metadata": {"filename": "04-model-change.md", "file_id": "model", "source_domain": "model"},
                "similarity": 0.6,
                "retrieval_score": 0.6,
            },
            {
                "id": "privacy",
                "content": "患者授权和目的限制会约束模型上线。",
                "metadata": {"filename": "06-patient-consent.md", "file_id": "privacy", "source_domain": "privacy"},
                "similarity": 0.55,
                "retrieval_score": 0.55,
            },
            {
                "id": "payment",
                "content": "医保支付规则可能构成重大变更。",
                "metadata": {"filename": "10-insurance-payment.md", "file_id": "payment", "source_domain": "payment"},
                "similarity": 0.5,
                "retrieval_score": 0.5,
            },
            {
                "id": "sre",
                "content": "SRE 事故恢复期间需要冻结高风险变更。",
                "metadata": {"filename": "15-sre-incident.md", "file_id": "sre", "source_domain": "operations"},
                "similarity": 0.45,
                "retrieval_score": 0.45,
            },
        ]

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            return documents

        result = agentic_retrieve(
            query="模型重大变更上线前是否必须完成双签，还是可以按 2024 口径 14 日内补交？",
            user_id="user-1",
            project_space_id="space-1",
            limit=5,
            threshold=0,
            retrieve_fn=fake_retrieve,
        )

        selected_domains = [document["metadata"].get("source_domain") for document in result["results"]]
        self.assertGreaterEqual(len(set(selected_domains)), 4)
        self.assertIn("model", selected_domains)
        self.assertIn("privacy", selected_domains)
        self.assertIn("payment", selected_domains)
        self.assertIn("operations", selected_domains)

    def test_agentic_retrieve_retries_with_expanded_query_when_initial_evidence_is_empty(self):
        calls = []

        def fake_retrieve(query, user_id, project_space_id, limit, threshold):
            calls.append(query)
            if "相关背景" not in query:
                return []
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
        self.assertEqual(result["results"][0]["id"], "chunk-retry")
        retry_steps = [step for step in result["trace_steps"] if step["step_type"] == "retrieve_retry"]
        self.assertEqual(retry_steps[-1]["status"], "success")

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
            "limit": 500,
        }])
        self.assertEqual(result["mode"], "metadata_inventory")
        self.assertEqual(len(result["results"]), 2)
        self.assertIn("0-小册介绍.md", result["results"][0]["content"])
        self.assertEqual(result["results"][0]["metadata"]["retrieval_mode"], "metadata_inventory")
        self.assertEqual(result["quality"]["evidence_label"], "strong")

        step_types = [step["step_type"] for step in result["trace_steps"]]
        self.assertEqual(step_types, ["intent_route", "metadata_lookup", "evidence_check"])

    def test_agentic_retrieve_routes_document_count_questions_to_full_inventory(self):
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
                    "filename": f"{index:02d}-demo.md",
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
        )

        self.assertEqual(retrieve_calls, [])
        self.assertEqual(inventory_calls, [500])
        self.assertEqual(result["mode"], "metadata_inventory")
        self.assertEqual(result["inventory_total"], 30)
        self.assertEqual(len(result["results"]), 30)
        self.assertIn("30 篇", result["answer_guidance"])

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
        self.assertEqual(inventory_calls, [500])
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

    def test_main_exposes_agentic_retrieve_endpoint(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("AgenticRetrieveRequest", source)
        self.assertIn('@app.post("/agentic-retrieve")', source)
        self.assertIn("agentic_retrieve(", source)
        self.assertIn("return agentic_retrieve", source)

    def test_retrieval_module_uses_hybrid_text_and_vector_scoring(self):
        retrieval_source = (ROOT / "retrieval.py").read_text(encoding="utf-8")
        db_source = (ROOT / "db.py").read_text(encoding="utf-8")
        migration_source = (ROOT.parent / "server" / "migrations" / "0013_file_chunks_text_search.sql").read_text(encoding="utf-8")

        self.assertIn("search_chunks_by_text", retrieval_source)
        self.assertIn("retrieval_score", retrieval_source)
        self.assertIn("vector_similarity", retrieval_source)
        self.assertIn("lexical_score", retrieval_source)
        self.assertIn("retrieval_mode", retrieval_source)
        self.assertIn("def search_chunks_by_text", db_source)
        self.assertIn("websearch_to_tsquery", db_source)
        self.assertIn("(%s::text is null or files.project_space_id::text = %s)", db_source)
        self.assertIn("to_tsvector('simple', content)", migration_source)
        self.assertIn("file_chunks_content_search_idx", migration_source)

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

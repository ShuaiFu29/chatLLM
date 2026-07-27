import unittest
from unittest.mock import patch

from config import settings
from reranker import extract_exact_markers, rerank_documents
from semantic_reranker import rerank_with_provider, reranker_fingerprint


class RerankerTests(unittest.TestCase):
    def test_exact_marker_preserves_full_dotted_version(self):
        markers = extract_exact_markers(
            "API-V2.4 running v3.1.4 on 2026-07-26 uses a 250 ms timeout and costs $30"
        )

        self.assertIn("API-V2.4", markers)
        self.assertNotIn("API-V2", markers)
        self.assertIn("V3.1.4", markers)
        self.assertIn("2026-07-26", markers)
        self.assertIn("250MS", markers)
        self.assertIn("$30", markers)

    def test_default_reranker_keeps_rrf_confidence_as_primary_signal(self):
        documents = [
            {
                "id": "rank-one",
                "content": "OAuth session rotation guidance.",
                "retrieval_score": 1.0,
            },
            {
                "id": "rank-two",
                "content": "OAuth session rotation guidance with an additional example.",
                "retrieval_score": 0.4,
            },
        ]

        reranked = rerank_documents("OAuth session rotation guidance", documents, top_k=2)

        self.assertEqual(reranked[0]["id"], "rank-one")
        self.assertEqual(reranked[0]["pre_rerank_rank"], 1)
        self.assertGreater(reranked[0]["rerank_score"], reranked[1]["rerank_score"])
        self.assertEqual(reranked[0]["reranker"], "local-evidence-v2")
        self.assertEqual(reranked[0]["source_role"], "unclassified")

    def test_reranker_rewards_exact_identifiers_without_corpus_rules(self):
        documents = [
            {
                "id": "generic",
                "content": "The deployment guide describes general timeout settings.",
                "retrieval_score": 0.7,
            },
            {
                "id": "exact",
                "content": "API-V2.4 uses a 30% retry budget during deployment.",
                "retrieval_score": 0.7,
            },
        ]

        reranked = rerank_documents("What retry budget applies to API-V2.4?", documents)

        self.assertEqual(reranked[0]["id"], "exact")
        self.assertIn("API-V2.4", reranked[0]["matched_terms"])

    def test_reranker_uses_filename_match_only_as_a_tie_breaker(self):
        documents = [
            {
                "id": "shared",
                "content": "Refresh token rotation is required for long-lived sessions.",
                "metadata": {"filename": "security-overview.md"},
                "retrieval_score": 0.8,
            },
            {
                "id": "named-source",
                "content": "Refresh token rotation is required for long-lived sessions.",
                "metadata": {"filename": "oauth-session-policy.md"},
                "retrieval_score": 0.8,
            },
        ]

        reranked = rerank_documents("OAuth refresh token rotation", documents)

        self.assertEqual(reranked[0]["id"], "named-source")
        self.assertGreater(reranked[0]["filename_match_score"], 0)

    def test_local_reranker_rewards_heading_and_answer_bearing_evidence(self):
        documents = [
            {
                "id": "question-only",
                "content": "Redis AOF 损坏后如何恢复？",
                "metadata": {"filename": "faq.md", "heading_path": ["常见问题"]},
                "retrieval_score": 0.8,
            },
            {
                "id": "answer",
                "content": "先运行 redis-check-aof 修复尾部，再从最近一次备份恢复并校验。",
                "metadata": {"filename": "redis.md", "heading_path": ["Redis", "AOF 损坏恢复"]},
                "retrieval_score": 0.8,
            },
        ]

        reranked = rerank_documents("Redis AOF 损坏后如何恢复？", documents)

        self.assertEqual(reranked[0]["id"], "answer")
        self.assertGreater(reranked[0]["heading_match_score"], 0)
        self.assertGreater(reranked[0]["answer_bearing_score"], reranked[1]["answer_bearing_score"])

    def test_local_reranker_suppresses_same_source_duplicate_chunks(self):
        documents = [
            {
                "id": "first",
                "content": "消费者处理完成后发送 ACK，失败消息进入重试队列。",
                "metadata": {"file_id": "queue-doc"},
                "retrieval_score": 1.0,
            },
            {
                "id": "duplicate",
                "content": "消费者处理完成后发送 ACK，失败消息进入重试队列。",
                "metadata": {"file_id": "queue-doc"},
                "retrieval_score": 0.99,
            },
            {
                "id": "independent",
                "content": "重试超过上限后进入死信队列，由补偿任务处理。",
                "metadata": {"file_id": "queue-doc"},
                "retrieval_score": 0.9,
            },
        ]

        reranked = rerank_documents("消息消费失败如何重试？", documents)

        duplicate = next(item for item in reranked if item["id"] == "duplicate")
        self.assertEqual(duplicate["duplicate_penalty"], 0.12)
        self.assertLess(duplicate["rerank_score"], duplicate["base_rerank_score"])

    def test_semantic_reranker_orders_rrf_candidates_by_provider_result(self):
        documents = [
            {"id": "rrf-first", "content": "Generic queue notes", "retrieval_score": 1.0},
            {"id": "semantic-first", "content": "Consumer acknowledgement recovery", "retrieval_score": 0.7},
        ]

        with patch.object(settings, "reranker_enabled", True), patch.object(
            settings, "reranker_api_key", "test-key"
        ), patch.object(settings, "reranker_base_url", "https://reranker.invalid/v1"), patch.object(
            settings, "reranker_model", "test-reranker"
        ), patch("semantic_reranker.post_json", return_value={
            "results": [
                {"index": 1, "relevance_score": 8.1},
                {"index": 0, "relevance_score": 2.4},
            ],
        }):
            reranked = rerank_with_provider("How are consumers recovered?", documents)

        self.assertEqual(reranked[0]["id"], "semantic-first")
        self.assertEqual(reranked[0]["reranker"], "test-reranker")
        self.assertEqual(reranked[0]["reranker_score_type"], "provider_relevance_uncalibrated")
        self.assertEqual(reranked[0]["semantic_rerank_score"], 8.1)

    def test_semantic_reranker_falls_back_without_exposing_provider_error(self):
        documents = [
            {"id": "first", "content": "OAuth rotation", "retrieval_score": 1.0},
            {"id": "second", "content": "Unrelated notes", "retrieval_score": 0.2},
        ]

        with patch.object(settings, "reranker_enabled", True), patch.object(
            settings, "reranker_api_key", "test-key"
        ), patch.object(settings, "reranker_base_url", "https://reranker.invalid/v1"), patch.object(
            settings, "reranker_model", "test-reranker"
        ), patch("semantic_reranker.post_json", side_effect=RuntimeError("secret provider body")):
            reranked = rerank_with_provider("OAuth rotation", documents)

        self.assertEqual(reranked[0]["id"], "first")
        self.assertEqual(reranked[0]["reranker_fallback"], "provider_unavailable")
        self.assertNotIn("secret provider body", str(reranked))

    def test_reranker_fingerprint_changes_with_result_affecting_configuration(self):
        with patch.object(settings, "reranker_enabled", True), patch.object(
            settings, "reranker_base_url", "https://reranker-a.invalid/v1"
        ), patch.object(settings, "reranker_model", "semantic-v1"), patch.object(
            settings, "reranker_top_n", 10
        ), patch.object(settings, "reranker_max_document_chars", 2000):
            first = reranker_fingerprint()
            settings.reranker_top_n = 20
            second = reranker_fingerprint()

        self.assertNotEqual(first, second)

    def test_semantic_reranker_rejects_non_finite_provider_scores(self):
        documents = [{"id": "first", "content": "OAuth rotation", "retrieval_score": 1.0}]
        with patch.object(settings, "reranker_enabled", True), patch.object(
            settings, "reranker_api_key", "test-key"
        ), patch.object(settings, "reranker_base_url", "https://reranker.invalid/v1"), patch.object(
            settings, "reranker_model", "test-reranker"
        ), patch("semantic_reranker.post_json", return_value={
            "results": [{"index": 0, "relevance_score": "NaN"}],
        }):
            reranked = rerank_with_provider("OAuth rotation", documents)

        self.assertEqual(reranked[0]["reranker_fallback"], "provider_unavailable")


if __name__ == "__main__":
    unittest.main()

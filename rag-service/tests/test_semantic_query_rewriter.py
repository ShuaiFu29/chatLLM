import json
import unittest
from unittest.mock import patch

import semantic_query_rewriter as rewriter


class SemanticQueryRewriterTests(unittest.TestCase):
    def _resolution(self):
        return {
            "original_query": "那 API-v2 失败后呢？",
            "standalone_query": "订单服务如何调用 API-v2；追问：那 API-v2 失败后呢？",
            "context_dependent": True,
            "resolution_method": "previous_user_turn_context",
            "confidence": "medium",
            "context_turns_used": 1,
            "reference_terms": ["那"],
        }

    def test_valid_semantic_rewrite_preserves_markers_and_adds_variants(self):
        response = {
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "standalone_query": "订单服务调用 API-v2 失败后如何处理？",
                        "alternative_queries": ["API-v2 调用失败 重试 降级"],
                        "context_dependent": True,
                        "reasoning": "Resolved the follow-up from the previous turn.",
                    }, ensure_ascii=False),
                },
            }],
        }
        with (
            patch.object(rewriter.settings, "query_rewrite_enabled", True),
            patch.object(rewriter.settings, "query_rewrite_api_key", "key"),
            patch.object(rewriter.settings, "query_rewrite_base_url", "https://example.test/v1"),
            patch.object(rewriter.settings, "query_rewrite_model", "rewrite-model"),
            patch.object(rewriter.settings, "query_rewrite_timeout_ms", 1000),
            patch.object(rewriter.settings, "query_rewrite_max_alternatives", 2),
            patch.object(rewriter, "post_json", return_value=response),
        ):
            result = rewriter.rewrite_query_resolution(
                self._resolution(),
                [{"role": "user", "content": "订单服务如何调用 API-v2？"}],
            )

        self.assertEqual(result["resolution_method"], "llm_semantic_rewrite")
        self.assertTrue(result["semantic_rewrite"]["applied"])
        self.assertEqual(result["semantic_alternatives"], ["API-v2 调用失败 重试 降级"])

    def test_invented_identifier_falls_back_to_deterministic_resolution(self):
        response = {
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "standalone_query": "订单服务调用 API-v2 和 SecretGateway 失败后如何处理？",
                        "alternative_queries": [],
                        "context_dependent": True,
                        "reasoning": "Added an unsupported entity.",
                    }, ensure_ascii=False),
                },
            }],
        }
        deterministic = self._resolution()
        with (
            patch.object(rewriter.settings, "query_rewrite_enabled", True),
            patch.object(rewriter.settings, "query_rewrite_api_key", "key"),
            patch.object(rewriter.settings, "query_rewrite_base_url", "https://example.test/v1"),
            patch.object(rewriter.settings, "query_rewrite_model", "rewrite-model"),
            patch.object(rewriter.settings, "query_rewrite_timeout_ms", 1000),
            patch.object(rewriter.settings, "query_rewrite_max_alternatives", 2),
            patch.object(rewriter, "post_json", return_value=response),
        ):
            result = rewriter.rewrite_query_resolution(deterministic, [])

        self.assertEqual(result["standalone_query"], deterministic["standalone_query"])
        self.assertFalse(result["semantic_rewrite"]["applied"])
        self.assertEqual(result["semantic_rewrite"]["status"], "fallback")

    def test_removed_negation_or_invented_number_falls_back(self):
        response = {
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "standalone_query": "订单服务调用 API-v2 时重试 9 次吗？",
                        "alternative_queries": [],
                        "context_dependent": True,
                        "reasoning": "Changed retrieval constraints.",
                    }, ensure_ascii=False),
                },
            }],
        }
        deterministic = {
            **self._resolution(),
            "original_query": "API-v2 不能重试 3 次吗？",
            "standalone_query": "订单服务调用 API-v2；追问：API-v2 不能重试 3 次吗？",
        }
        with (
            patch.object(rewriter.settings, "query_rewrite_enabled", True),
            patch.object(rewriter.settings, "query_rewrite_api_key", "key"),
            patch.object(rewriter.settings, "query_rewrite_base_url", "https://example.test/v1"),
            patch.object(rewriter.settings, "query_rewrite_model", "rewrite-model"),
            patch.object(rewriter.settings, "query_rewrite_timeout_ms", 1000),
            patch.object(rewriter.settings, "query_rewrite_max_alternatives", 2),
            patch.object(rewriter, "post_json", return_value=response),
        ):
            result = rewriter.rewrite_query_resolution(deterministic, [])

        self.assertEqual(result["standalone_query"], deterministic["standalone_query"])
        self.assertEqual(result["semantic_rewrite"]["status"], "fallback")


if __name__ == "__main__":
    unittest.main()

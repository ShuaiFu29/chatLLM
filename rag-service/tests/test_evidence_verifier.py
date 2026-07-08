import unittest

from evidence_verifier import assess_query_risk, verify_evidence_support


class EvidenceVerifierTests(unittest.TestCase):
    def test_high_risk_query_requires_exact_markers_before_cache_reuse(self):
        documents = [
            {
                "id": "cached-default-rule",
                "content": "2026 修订版规定默认响应确认窗口是 T+5 分钟，但没有覆盖华东 E-2 特例。",
                "metadata": {"filename": "current-rule.md", "file_id": "rule", "chunk_index": 0},
                "agentic_score": 0.88,
                "source_role": "primary",
            }
        ]

        verification = verify_evidence_support(
            "华东 E-2 紧急等级下，响应确认窗口应按 T+5 还是 T+3？",
            documents,
            cache_hit_type="exact",
            query_similarity=1.0,
        )

        self.assertEqual(verification["risk_level"], "high")
        self.assertIn("T+3", verification["missing_markers"])
        self.assertEqual(verification["support_label"], "partial")
        self.assertFalse(verification["cache_reuse_allowed"])
        self.assertTrue(verification["must_retrieve"])

    def test_supported_primary_evidence_can_reuse_exact_cache(self):
        documents = [
            {
                "id": "current-e2-rule",
                "content": "华东 E-2 紧急等级需要并读区域附件；响应确认窗口按 T+3，不能沿用默认 T+5。",
                "metadata": {"filename": "regional-appendix.md", "file_id": "regional", "chunk_index": 2},
                "agentic_score": 0.91,
                "source_role": "primary",
            }
        ]

        verification = verify_evidence_support(
            "华东 E-2 紧急等级下，响应确认窗口应按 T+5 还是 T+3？",
            documents,
            cache_hit_type="exact",
            query_similarity=1.0,
        )

        self.assertEqual(verification["support_label"], "supported")
        self.assertGreaterEqual(verification["support_score"], 0.75)
        self.assertEqual(verification["missing_markers"], [])
        self.assertTrue(verification["cache_reuse_allowed"])
        self.assertFalse(verification["must_retrieve"])

    def test_risk_assessment_detects_regulatory_and_numeric_questions(self):
        risk = assess_query_risk("CN 患者原始诊疗文本是否能同步到 EU 分析域？需要满足哪条合规要求？")

        self.assertEqual(risk["risk_level"], "high")
        self.assertIn("regulatory", risk["risk_factors"])
        self.assertIn("cross_region", risk["risk_factors"])


if __name__ == "__main__":
    unittest.main()

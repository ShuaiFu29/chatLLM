import unittest

from evidence_verifier import assess_query_risk, verify_evidence_support


class EvidenceVerifierTests(unittest.TestCase):
    def test_high_risk_query_requires_exact_markers_before_cache_reuse(self):
        documents = [
            {
                "id": "cached-default-rule",
                "content": "API v2.4 currently uses a 500ms request timeout.",
                "metadata": {"filename": "api-reference.md", "file_id": "api", "chunk_index": 0},
                "agentic_score": 0.88,
                "source_role": "primary",
            }
        ]

        verification = verify_evidence_support(
            "Must API v2.4 use a 250ms or 500ms timeout?",
            documents,
            cache_hit_type="exact",
            query_similarity=1.0,
        )

        self.assertEqual(verification["risk_level"], "high")
        self.assertIn("250MS", verification["missing_markers"])
        self.assertEqual(verification["support_label"], "partial")
        self.assertFalse(verification["cache_reuse_allowed"])
        self.assertTrue(verification["must_retrieve"])

    def test_supported_primary_evidence_can_reuse_exact_cache(self):
        documents = [
            {
                "id": "current-e2-rule",
                "content": "API v2.4 must use a 250ms timeout and must not use the legacy 500ms timeout.",
                "metadata": {"filename": "api-reference.md", "file_id": "api", "chunk_index": 2},
                "agentic_score": 0.91,
                "source_role": "primary",
            }
        ]

        verification = verify_evidence_support(
            "Must API v2.4 use a 250ms or 500ms timeout?",
            documents,
            cache_hit_type="exact",
            query_similarity=1.0,
        )

        self.assertEqual(verification["support_label"], "supported")
        self.assertGreaterEqual(verification["support_score"], 0.75)
        self.assertEqual(verification["missing_markers"], [])
        self.assertTrue(verification["cache_reuse_allowed"])
        self.assertFalse(verification["must_retrieve"])

    def test_risk_assessment_uses_query_structure_instead_of_domain_terms(self):
        risk = assess_query_risk("Must client v2.4 use a 250ms timeout, and why?")

        self.assertEqual(risk["risk_level"], "high")
        self.assertIn("constraint", risk["risk_factors"])
        self.assertIn("exact_marker", risk["risk_factors"])

    def test_question_only_passage_cannot_approve_exact_cache_reuse(self):
        verification = verify_evidence_support(
            "What are the refund conditions?",
            [{
                "id": "faq-heading",
                "content": "FAQ: What are the refund conditions?",
                "metadata": {"filename": "billing.md", "file_id": "billing", "chunk_index": 0},
                "agentic_score": 0.95,
            }],
            cache_hit_type="exact",
            query_similarity=1.0,
        )

        self.assertNotEqual(verification["support_label"], "supported")
        self.assertIn("no_answer_bearing_evidence", verification["reasons"])
        self.assertFalse(verification["cache_reuse_allowed"])
        self.assertTrue(verification["must_retrieve"])


if __name__ == "__main__":
    unittest.main()

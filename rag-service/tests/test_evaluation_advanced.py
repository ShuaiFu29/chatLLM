import unittest

from eval_runner import run_eval_cases
from evaluation import evaluate_gold_graph_quality


class AdvancedEvaluationTests(unittest.TestCase):
    def test_graph_precision_deduplicates_normalized_relations_across_documents(self):
        documents = [
            {
                "metadata": {
                    "graph_relations": [
                        {"from": "Worker", "type": "USES", "to": "Queue"},
                        {"from": "Worker", "type": "USES", "to": "Cache"},
                    ],
                },
            },
            {
                "metadata": {
                    "graph_relations": [
                        {"source": " worker ", "label": " uses ", "target": " CACHE "},
                    ],
                },
            },
        ]

        quality = evaluate_gold_graph_quality(
            [{"source": "Worker", "relation": "USES", "target": "Queue"}],
            documents,
            k=2,
        )

        self.assertEqual(quality["recall_at_k"], 1)
        self.assertEqual(quality["precision_at_k"], 0.5)
        self.assertEqual(quality["mrr_at_k"], 1)

    def test_chunk_evidence_graph_answerability_calibration_and_usage_are_separate_metrics(self):
        document = {
            "id": "parent:file-1:section-a",
            "content": "# Retry\n\nWorker retries through Queue after a timeout.",
            "metadata": {
                "file_id": "file-1",
                "filename": "reliability.md",
                "chunk_index": 2,
                "matched_child_ids": ["chunk-2"],
                "graph_relations": [{
                    "from": "Worker",
                    "to": "Queue",
                    "type": "USES",
                    "label": "retries through",
                    "evidence": "Worker retries through Queue after a timeout.",
                }],
            },
            "agentic_score": 0.9,
        }
        case = {
            "id": "case-advanced",
            "question": "How does Worker retry?",
            "expected_answer": "Worker retries through Queue.",
            "expected_source_files": ["file-1"],
            "actual_answer": "Worker retries through Queue. [Source 1]",
            "retrieval_snapshot": {
                "run_id": "retrieval-run",
                "results": [document],
                "answer_sources": [document],
                "quality": {"evidence_label": "strong", "support_label": "supported"},
                "actual_answer": "Worker retries through Queue. [Source 1]",
            },
            "answer_evaluation": {
                "citation_precision": 1,
                "citation_coverage": 1,
                "citation_f1": 1,
                "hallucination_rate": 0,
                "abstained": False,
                "metric_applicability": {
                    "claim_verification": True,
                    "citation_precision": True,
                    "citation_coverage": True,
                    "citation_f1": True,
                    "hallucination_rate": True,
                },
            },
            "generation_metadata": {
                "token_usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
            },
            "evaluation_spec": {
                "tags": ["multi-hop", "reliability"],
                "category": "backend",
                "difficulty": "hard",
                "expected_chunk_ids": ["chunk-2"],
                "expected_evidence": ["Worker retries through Queue after a timeout."],
                "expected_answerable": True,
                "expected_graph_relations": [{
                    "source": "Worker", "relation": "USES", "target": "Queue",
                }],
                "human_scores": {"correctness": 0.9, "completeness": 0.8, "faithfulness": 1.0},
            },
        }

        def judge(_case, _retrieval, _documents):
            return {
                "enabled": True,
                "correctness": 0.8,
                "completeness": 0.8,
                "faithfulness": 0.9,
                "score": 0.8,
                "label": "grounded",
                "token_usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
            }

        output = run_eval_cases([case], "user-1", judge_fn=judge)
        result = output["results"][0]
        advanced = result["advanced_metrics"]

        self.assertEqual(advanced["chunk_retrieval"]["recall_at_k"], 1)
        self.assertEqual(advanced["evidence_retrieval"]["recall_at_k"], 1)
        self.assertEqual(advanced["graph_retrieval"]["recall_at_k"], 1)
        self.assertEqual(advanced["answerability"]["accuracy"], 1)
        self.assertAlmostEqual(advanced["judge_human_calibration"]["mae"], 0.0667, places=4)
        self.assertEqual(output["advanced_metrics"]["token_usage"]["answer"]["total_tokens"], 120)
        self.assertEqual(output["advanced_metrics"]["token_usage"]["judge"]["total_tokens"], 60)
        self.assertFalse(output["advanced_metrics"]["cost"]["applicable"])
        retrieval_ci = output["advanced_metrics"]["confidence_intervals"]["retrieval_score"]
        self.assertTrue(retrieval_ci["applicable"])
        self.assertEqual(retrieval_ci["confidence_level"], 0.95)
        slices = {item["slice"]: item for item in output["advanced_metrics"]["slices"]}
        self.assertIn("tag:multi-hop", slices)
        self.assertIn("category:backend", slices)
        self.assertIn("difficulty:hard", slices)
        self.assertIn("answerability:answerable", slices)


if __name__ == "__main__":
    unittest.main()

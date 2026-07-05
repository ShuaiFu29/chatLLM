import unittest
from pathlib import Path

from eval_runner import run_eval_cases

ROOT = Path(__file__).resolve().parents[1]


class EvalRunnerTests(unittest.TestCase):
    def test_run_eval_cases_scores_keywords_sources_and_trace(self):
        def fake_agentic_retrieve(query, user_id, project_space_id, limit, threshold):
            return {
                "run_id": f"run-{query[:4]}",
                "mode": "agentic",
                "planned_queries": [query, "oauth refresh tokens"],
                "trace_steps": [{"step_type": "retrieve", "status": "success", "duration_ms": 3}],
                "quality": {
                    "retrieval_score": 0.8,
                    "citation_score": 1,
                    "evidence_score": 0.75,
                    "overall_score": 0.82,
                    "evidence_label": "strong",
                },
                "results": [
                    {
                        "id": "chunk-1",
                        "content": "OAuth uses GitHub code exchange and refresh token rotation. It stores a short lived access token and rotates refresh tokens for safety.",
                        "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 0},
                        "similarity": 0.91,
                    }
                ],
            }

        output = run_eval_cases(
            cases=[
                {
                    "id": "case-1",
                    "question": "How does OAuth refresh work?",
                    "expected_answer": "OAuth exchanges a GitHub code, uses access tokens, and rotates refresh tokens.",
                    "expected_keywords": ["oauth", "refresh token"],
                    "expected_source_files": ["auth.md"],
                }
            ],
            user_id="user-1",
            project_space_id="space-1",
            agentic_retrieve_fn=fake_agentic_retrieve,
        )

        self.assertEqual(output["case_count"], 1)
        self.assertEqual(output["failed_count"], 0)
        self.assertGreater(output["average_overall_score"], 0.8)
        self.assertEqual(output["average_answer_score"], 1)
        self.assertEqual(output["results"][0]["case_id"], "case-1")
        self.assertEqual(output["results"][0]["answer_score"], 1)
        self.assertEqual(output["results"][0]["source_score"], 1)
        self.assertEqual(output["results"][0]["keyword_score"], 1)
        self.assertEqual(output["results"][0]["evidence_label"], "strong")
        self.assertEqual(output["results"][0]["matched_sources"][0]["filename"], "auth.md")
        self.assertEqual(output["results"][0]["trace_summary"]["planned_queries"][0], "How does OAuth refresh work?")

    def test_run_eval_cases_records_case_failures_without_aborting_batch(self):
        def failing_agentic_retrieve(query, user_id, project_space_id, limit, threshold):
            raise RuntimeError("vector store unavailable")

        output = run_eval_cases(
            cases=[{"id": "case-1", "question": "What failed?"}],
            user_id="user-1",
            agentic_retrieve_fn=failing_agentic_retrieve,
        )

        self.assertEqual(output["case_count"], 1)
        self.assertEqual(output["failed_count"], 1)
        self.assertEqual(output["average_overall_score"], 0)
        self.assertEqual(output["average_answer_score"], 0)
        self.assertEqual(output["results"][0]["answer_score"], 0)
        self.assertEqual(output["results"][0]["error_message"], "vector store unavailable")

    def test_main_exposes_eval_run_endpoint(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("EvalRunRequest", source)
        self.assertIn("expected_answer: str", source)
        self.assertIn('@app.post("/eval/run")', source)
        self.assertIn("run_eval_cases(", source)

    def test_eval_run_endpoint_bounds_case_count(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("cases: list[EvalCaseRequest] = Field(..., min_length=1, max_length=50)", source)


if __name__ == "__main__":
    unittest.main()

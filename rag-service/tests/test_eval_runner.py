import unittest
from pathlib import Path

from eval_runner import run_eval_cases

ROOT = Path(__file__).resolve().parents[1]


class EvalRunnerTests(unittest.TestCase):
    def test_run_eval_cases_calls_agentic_retrieve_with_current_keyword_signature(self):
        calls = []

        def fake_agentic_retrieve(
            query,
            user_id,
            project_space_id=None,
            conversation_id=None,
            limit=5,
            threshold=0.1,
        ):
            calls.append({
                "query": query,
                "user_id": user_id,
                "project_space_id": project_space_id,
                "conversation_id": conversation_id,
                "limit": limit,
                "threshold": threshold,
            })
            return {
                "run_id": "run-signature",
                "mode": "agentic",
                "planned_queries": [query],
                "trace_steps": [],
                "quality": {
                    "retrieval_score": 0.8,
                    "citation_score": 1,
                    "evidence_score": 0.8,
                    "overall_score": 0.8,
                    "evidence_label": "strong",
                },
                "results": [{
                    "id": "chunk-1",
                    "content": "OAuth refresh token rotation evidence.",
                    "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 0},
                    "similarity": 0.8,
                }],
            }

        output = run_eval_cases(
            cases=[{"id": "case-signature", "question": "How does OAuth refresh work?"}],
            user_id="user-1",
            project_space_id="space-1",
            limit=8,
            threshold=0.25,
            agentic_retrieve_fn=fake_agentic_retrieve,
            judge_fn=None,
        )

        self.assertEqual(output["failed_count"], 0)
        self.assertEqual(calls, [{
            "query": "How does OAuth refresh work?",
            "user_id": "user-1",
            "project_space_id": "space-1",
            "conversation_id": None,
            "limit": 8,
            "threshold": 0.25,
        }])

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
                    "support_label": "supported",
                    "verification_score": 0.91,
                    "risk_level": "low",
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
        self.assertEqual(output["results"][0]["source_recall_score"], 1)
        self.assertEqual(output["results"][0]["source_precision_score"], 1)
        self.assertEqual(output["results"][0]["citation_accuracy_score"], 1)
        self.assertEqual(output["results"][0]["answer_keyword_score"], 1)
        self.assertGreater(output["results"][0]["grounding_score"], 0.95)
        self.assertGreater(output["results"][0]["expected_answer_support_score"], 0.9)
        self.assertEqual(output["results"][0]["expected_answer_support_label"], "supported")
        self.assertEqual(output["results"][0]["keyword_score"], 1)
        self.assertEqual(output["results"][0]["evidence_label"], "strong")
        self.assertEqual(output["results"][0]["support_label"], "supported")
        self.assertEqual(output["results"][0]["verification_score"], 0.91)
        self.assertEqual(output["results"][0]["risk_level"], "low")
        self.assertEqual(output["results"][0]["matched_sources"][0]["filename"], "auth.md")
        self.assertEqual(output["results"][0]["trace_summary"]["planned_queries"][0], "How does OAuth refresh work?")
        self.assertGreaterEqual(output["results"][0]["latency_ms"], 0)
        self.assertEqual(output["average_source_recall_score"], 1)
        self.assertEqual(output["average_citation_accuracy_score"], 1)
        self.assertEqual(output["average_answer_keyword_score"], 1)
        self.assertGreater(output["average_grounding_score"], 0.95)
        self.assertGreater(output["average_expected_answer_support_score"], 0.9)
        self.assertEqual(output["average_verification_score"], 0.91)

    def test_run_eval_cases_records_case_failures_without_aborting_batch(self):
        def failing_agentic_retrieve(query, user_id, project_space_id, limit, threshold):
            raise RuntimeError("vector store unavailable with injected-secret-value")

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
        self.assertEqual(output["results"][0]["source_recall_score"], 0)
        self.assertEqual(output["results"][0]["citation_accuracy_score"], 0)
        self.assertEqual(output["results"][0]["grounding_score"], 0)
        self.assertGreaterEqual(output["results"][0]["latency_ms"], 0)
        self.assertEqual(output["results"][0]["error_message"], "Evaluation case failed")
        self.assertNotIn("injected-secret-value", str(output))

    def test_run_eval_cases_can_apply_llm_judge_to_answer_and_trace(self):
        def fake_agentic_retrieve(query, user_id, project_space_id, limit, threshold):
            return {
                "run_id": "run-judge",
                "mode": "agentic",
                "planned_queries": [query],
                "trace_steps": [{"step_type": "retrieve", "status": "success", "duration_ms": 1}],
                "quality": {
                    "retrieval_score": 0.6,
                    "citation_score": 1,
                    "evidence_score": 0.6,
                    "overall_score": 0.65,
                    "evidence_label": "partial",
                },
                "results": [
                    {
                        "id": "chunk-1",
                        "content": "The current rule is T+5. T+7 is deprecated.",
                        "metadata": {"filename": "rule.md", "file_id": "file-rule", "chunk_index": 0},
                        "agentic_score": 0.8,
                    }
                ],
            }

        def fake_judge(case, retrieval, documents):
            return {
                "enabled": True,
                "score": 0.92,
                "label": "grounded",
                "reasoning": "The retrieved evidence supports the expected answer.",
            }

        output = run_eval_cases(
            cases=[{
                "id": "case-judge",
                "question": "What is the current response window?",
                "expected_answer": "The current response window is T+5, not deprecated T+7.",
                "expected_keywords": ["T+5", "T+7"],
                "expected_source_files": ["rule.md"],
            }],
            user_id="user-1",
            project_space_id="space-1",
            agentic_retrieve_fn=fake_agentic_retrieve,
            judge_fn=fake_judge,
        )

        result = output["results"][0]
        self.assertEqual(output["average_judge_score"], 0.92)
        self.assertEqual(result["judge_score"], 0.92)
        self.assertEqual(result["trace_summary"]["judge"]["label"], "grounded")
        self.assertGreater(result["overall_score"], 0.75)

    def test_run_eval_cases_penalizes_expected_answer_that_uses_deprecated_evidence(self):
        def fake_agentic_retrieve(query, user_id, project_space_id, limit, threshold):
            return {
                "run_id": "run-deprecated-answer",
                "mode": "agentic",
                "planned_queries": [query],
                "trace_steps": [{"step_type": "retrieve", "status": "success", "duration_ms": 1}],
                "quality": {
                    "retrieval_score": 0.9,
                    "citation_score": 1,
                    "evidence_score": 0.8,
                    "overall_score": 0.85,
                    "evidence_label": "strong",
                    "support_label": "supported",
                    "verification_score": 0.9,
                    "risk_level": "high",
                },
                "results": [
                    {
                        "id": "chunk-current",
                        "content": "2026 修订版当前总规则规定默认响应确认窗口是 T+5 分钟。",
                        "metadata": {"filename": "01-current.md", "file_id": "current", "chunk_index": 0},
                        "agentic_score": 0.9,
                    },
                    {
                        "id": "chunk-deprecated",
                        "content": "T+7 是 2025 试行版历史口径，已废止，不能替代 2026 当前规则。",
                        "metadata": {"filename": "02-deprecated.md", "file_id": "deprecated", "chunk_index": 0},
                        "agentic_score": 0.88,
                        "source_role": "deprecated",
                    },
                ],
            }

        output = run_eval_cases(
            cases=[{
                "id": "case-deprecated",
                "question": "2026 年默认响应确认窗口是多少？",
                "expected_answer": "2026 年默认响应确认窗口是 T+7。",
                "expected_keywords": ["T+7"],
                "expected_source_files": ["01-current.md", "02-deprecated.md"],
            }],
            user_id="user-1",
            project_space_id="space-1",
            agentic_retrieve_fn=fake_agentic_retrieve,
            judge_fn=None,
        )

        result = output["results"][0]
        self.assertLess(result["grounding_score"], 0.7)
        self.assertLess(result["expected_answer_support_score"], 0.5)
        self.assertEqual(result["expected_answer_support_label"], "unsupported")
        self.assertIn("expected_answer_verification", result["trace_summary"])

    def test_main_exposes_eval_run_endpoint(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("EvalRunRequest", source)
        self.assertIn("expected_answer: str", source)
        self.assertIn('@app.post("/eval/run")', source)
        self.assertIn("run_eval_cases(", source)
        self.assertIn('@app.post("/ingest-sync")', source)

    def test_eval_run_endpoint_bounds_case_count(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("cases: list[EvalCaseRequest] = Field(..., min_length=1, max_length=50)", source)


if __name__ == "__main__":
    unittest.main()

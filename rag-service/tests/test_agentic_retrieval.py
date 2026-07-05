import unittest
from pathlib import Path

from agentic_retrieval import agentic_retrieve
from evaluation import evaluate_retrieval_quality
from query_planner import plan_queries

ROOT = Path(__file__).resolve().parents[1]


class AgenticRetrievalTests(unittest.TestCase):
    def test_plan_queries_deduplicates_and_keeps_original_first(self):
        queries = plan_queries("  How does OAuth login handle refresh tokens?  ", max_queries=3)

        self.assertGreaterEqual(len(queries), 1)
        self.assertLessEqual(len(queries), 3)
        self.assertEqual(queries[0], "How does OAuth login handle refresh tokens?")
        self.assertEqual(len(queries), len(set(queries)))
        self.assertTrue(all(query.strip() for query in queries))

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

    def test_evaluate_retrieval_quality_is_bounded_for_empty_results(self):
        quality = evaluate_retrieval_quality("missing deployment notes", [])

        self.assertEqual(quality["retrieval_score"], 0)
        self.assertEqual(quality["citation_score"], 0)
        self.assertEqual(quality["evidence_score"], 0)
        self.assertEqual(quality["overall_score"], 0)
        self.assertEqual(quality["evidence_label"], "weak")

    def test_main_exposes_agentic_retrieve_endpoint(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("AgenticRetrieveRequest", source)
        self.assertIn('@app.post("/agentic-retrieve")', source)
        self.assertIn("agentic_retrieve(", source)
        self.assertIn("return agentic_retrieve", source)


if __name__ == "__main__":
    unittest.main()

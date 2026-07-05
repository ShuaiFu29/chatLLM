import unittest
from pathlib import Path
from unittest.mock import patch

from agentic_retrieval import agentic_retrieve
from evaluation import evaluate_retrieval_quality
from query_planner import plan_queries
from retrieval import retrieve_documents

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

import threading
import unittest
from unittest.mock import patch

from fusion import reciprocal_rank_fuse
from keyword_store import KeywordStoreUnavailableError
from retrieval import retrieve_documents


class HybridRetrievalTests(unittest.TestCase):
    def test_rrf_fuses_ranked_lists_and_preserves_channel_ranks(self):
        fused = reciprocal_rank_fuse(
            [
                ("vector", [
                    {"id": "chunk-a", "content": "A"},
                    {"id": "chunk-b", "content": "B"},
                ]),
                ("bm25", [
                    {"id": "chunk-b", "content": "B"},
                    {"id": "chunk-c", "content": "C"},
                ]),
            ],
            k=60,
        )

        self.assertEqual([item["id"] for item in fused], ["chunk-b", "chunk-a", "chunk-c"])
        self.assertGreater(fused[0]["rrf_score"], fused[1]["rrf_score"])
        self.assertEqual(fused[0]["retrieval_channels"], ["vector", "bm25"])
        self.assertEqual(fused[0]["channel_ranks"]["vector"], 2)
        self.assertEqual(fused[0]["channel_ranks"]["bm25"], 1)

    def test_rrf_preserves_graph_provenance_when_primary_lane_sees_chunk_first(self):
        fused = reciprocal_rank_fuse([
            ("vector", [{"id": "shared", "content": "shared", "metadata": {"filename": "a.md"}}]),
            ("graph", [{
                "id": "shared",
                "content": "shared",
                "metadata": {
                    "filename": "a.md",
                    "graph_entities": ["Redis", "Worker"],
                    "graph_relations": [{"type": "CONNECTS_TO", "from": "Redis", "to": "Worker"}],
                },
                "graph_score": 3.0,
            }]),
        ])

        self.assertEqual(fused[0]["metadata"]["graph_entities"], ["Redis", "Worker"])
        self.assertEqual(fused[0]["metadata"]["graph_relations"][0]["type"], "CONNECTS_TO")
        self.assertEqual(fused[0]["graph_score"], 3.0)

    def test_retrieve_documents_combines_vector_and_bm25_results_with_rrf(self):
        vector_chunk = {
            "id": "chunk-vector",
            "file_id": "file-1",
            "user_id": "user-1",
            "chunk_index": 0,
            "content": "Semantic answer about JSBridge communication.",
            "metadata": {"filename": "webview.md"},
            "project_space_id": "space-1",
        }
        bm25_chunk = {
            "id": "chunk-bm25",
            "file_id": "file-1",
            "user_id": "user-1",
            "chunk_index": 1,
            "content": "JSBridge keyword appears in the WebView chapter.",
            "metadata": {"filename": "webview.md"},
            "project_space_id": "space-1",
            "filename": "webview.md",
            "lexical_score": 4.2,
        }

        authoritative_chunks = {
            vector_chunk["id"]: vector_chunk,
            bm25_chunk["id"]: bm25_chunk,
        }

        def hydrate(candidate_ids, _user_id, _project_space_id):
            return [
                authoritative_chunks[chunk_id]
                for chunk_id in candidate_ids
                if chunk_id in authoritative_chunks
            ]

        with patch("retrieval.get_embedding", return_value=[0.1, 0.2]), patch(
            "retrieval.search_vectors",
            return_value=[{
                "chunk_id": "chunk-vector",
                "file_id": "file-1",
                "user_id": "user-1",
                "filename": "webview.md",
                "chunk_index": 0,
                "similarity": 0.91,
            }],
        ), patch("retrieval.get_active_chunks_by_ids", side_effect=hydrate), patch(
            "retrieval.search_keyword_chunks",
            return_value=[{"chunk_id": "chunk-bm25", "lexical_score": 4.2}],
        ), patch(
            "retrieval.search_graph",
            return_value=[],
        ) as graph_search:
            documents = retrieve_documents(
                query="JSBridge WebView",
                user_id="user-1",
                project_space_id="space-1",
                limit=5,
                threshold=0.1,
            )

        self.assertEqual({doc["id"] for doc in documents}, {"chunk-vector", "chunk-bm25"})
        self.assertTrue(all("rrf_score" in doc for doc in documents))
        self.assertEqual(documents[0]["metadata"]["retrieval_mode"], "hybrid_rrf")
        self.assertIn("retrieval_channels", documents[0]["metadata"])
        self.assertEqual(documents[0]["retrieval_score"], 1.0)
        self.assertLess(documents[0]["rrf_score"], 1.0)
        graph_search.assert_not_called()

    def test_retrieve_documents_includes_graph_results_in_fusion(self):
        graph_chunk = {
            "id": "chunk-graph",
            "content": "Graph path: JSBridge -> connects -> Native.",
            "metadata": {
                "filename": "webview.md",
                "file_id": "file-1",
                "chunk_index": 3,
                "retrieval_mode": "graph",
            },
            "similarity": 1,
            "retrieval_score": 1,
        }

        with patch("retrieval.get_embedding", return_value=[0.1, 0.2]), patch(
            "retrieval.search_vectors",
            return_value=[],
        ), patch("retrieval.get_active_chunks_by_ids", return_value=[]), patch(
            "retrieval.search_keyword_chunks",
            return_value=[],
        ), patch("retrieval.search_chunks_by_text", return_value=[]), patch(
            "retrieval.search_graph",
            return_value=[graph_chunk],
        ):
            documents = retrieve_documents(
                query="JSBridge 和 Native 的关系",
                user_id="user-1",
                project_space_id="space-1",
                limit=5,
                threshold=0.1,
                routes=["vector", "bm25", "graph"],
            )

        self.assertEqual(documents[0]["id"], "chunk-graph")
        self.assertEqual(documents[0]["metadata"]["retrieval_channels"], ["graph"])
        self.assertEqual(documents[0]["metadata"]["retrieval_mode"], "graph")

    def test_retrieve_documents_runs_selected_lanes_in_parallel_and_fuses_in_fixed_order(self):
        barrier = threading.Barrier(3)

        def lane_result(channel):
            barrier.wait(timeout=2)
            return [{
                "id": f"chunk-{channel}",
                "content": f"evidence from {channel}",
                "metadata": {"filename": f"{channel}.md", "file_id": f"file-{channel}", "chunk_index": 0},
                "retrieval_score": 1.0,
            }]

        with patch(
            "retrieval._retrieve_vector_documents",
            side_effect=lambda *_args: lane_result("vector"),
        ), patch(
            "retrieval._keyword_documents",
            side_effect=lambda *_args: lane_result("bm25"),
        ), patch(
            "retrieval._retrieve_graph_documents",
            side_effect=lambda *_args: lane_result("graph"),
        ):
            documents = retrieve_documents(
                query="service dependency relationship",
                user_id="user-1",
                project_space_id="space-1",
                limit=3,
                routes=["graph", "bm25", "vector"],
            )

        self.assertEqual(
            [document["id"] for document in documents],
            ["chunk-vector", "chunk-bm25", "chunk-graph"],
        )

    def test_retrieve_documents_raises_only_when_every_selected_lane_fails(self):
        with patch(
            "retrieval._retrieve_vector_documents",
            side_effect=RuntimeError("vector unavailable"),
        ), patch(
            "retrieval._keyword_documents",
            side_effect=RuntimeError("keyword unavailable"),
        ):
            with self.assertRaisesRegex(RuntimeError, "vector, bm25"):
                retrieve_documents(
                    query="deployment policy",
                    user_id="user-1",
                    project_space_id="space-1",
                    routes=["vector", "bm25"],
                )

    def test_retrieve_documents_reports_partial_lane_failure_without_exposing_error(self):
        with patch(
            "retrieval._retrieve_vector_documents",
            side_effect=RuntimeError("secret provider response"),
        ), patch(
            "retrieval._keyword_documents",
            return_value=[{
                "id": "chunk-keyword",
                "content": "reliable consumer acknowledgements",
                "metadata": {"filename": "mq.md", "file_id": "file-mq", "chunk_index": 0},
                "lexical_score": 1.0,
                "retrieval_score": 1.0,
            }],
        ):
            documents = retrieve_documents(
                query="consumer reliability",
                user_id="user-1",
                project_space_id="space-1",
                routes=["vector", "bm25"],
            )

        self.assertEqual(documents.channel_status, {"vector": "error", "bm25": "ok"})
        self.assertTrue(documents.degraded)
        self.assertNotIn("secret provider response", str(documents.channel_status))

    def test_keyword_transport_failure_uses_postgres_fallback_and_reports_degraded(self):
        with patch(
            "retrieval.search_keyword_chunks",
            side_effect=KeywordStoreUnavailableError("Elasticsearch keyword search failed"),
        ), patch(
            "retrieval.search_chunks_by_text",
            return_value=[{
                "id": "chunk-postgres-fallback",
                "content": "fallback deployment policy",
                "metadata": {"filename": "policy.md", "file_id": "file-policy", "chunk_index": 0},
                "project_space_id": "space-1",
                "lexical_score": 1.0,
            }],
        ):
            documents = retrieve_documents(
                query="deployment policy",
                user_id="user-1",
                project_space_id="space-1",
                routes=["bm25"],
            )

        self.assertEqual([document["id"] for document in documents], ["chunk-postgres-fallback"])
        self.assertEqual(documents.channel_status, {"bm25": "degraded"})
        self.assertTrue(documents.degraded)

    def test_retrieve_documents_keeps_source_diversity_before_filling_remainder(self):
        vector_hits = [
            {
                "chunk_id": f"chunk-a-{index}",
                "file_id": "file-a",
                "user_id": "user-1",
                "filename": "a.md",
                "chunk_index": index,
                "similarity": 0.95 - (index * 0.01),
            }
            for index in range(4)
        ] + [{
            "chunk_id": "chunk-b-0",
            "file_id": "file-b",
            "user_id": "user-1",
            "filename": "b.md",
            "chunk_index": 0,
            "similarity": 0.6,
        }]
        chunks = [
            {
                "id": hit["chunk_id"],
                "file_id": hit["file_id"],
                "user_id": "user-1",
                "chunk_index": hit["chunk_index"],
                "content": f"content from {hit['filename']} #{hit['chunk_index']}",
                "metadata": {"filename": hit["filename"], "file_id": hit["file_id"]},
                "project_space_id": "space-1",
            }
            for hit in vector_hits
        ]

        with patch("retrieval.get_embedding", return_value=[0.1, 0.2]), patch(
            "retrieval.search_vectors",
            return_value=vector_hits,
        ), patch("retrieval.get_active_chunks_by_ids", return_value=chunks), patch(
            "retrieval.search_keyword_chunks",
            return_value=[],
        ), patch("retrieval.search_chunks_by_text", return_value=[]), patch(
            "retrieval.search_graph",
            return_value=[],
        ):
            documents = retrieve_documents(
                query="risk policy",
                user_id="user-1",
                project_space_id="space-1",
                limit=4,
                threshold=0.1,
            )

        self.assertIn("file-b", {doc["metadata"]["file_id"] for doc in documents})
        self.assertLessEqual(
            sum(1 for doc in documents if doc["metadata"]["file_id"] == "file-a"),
            3,
        )
        self.assertTrue(all("source_diversity_rank" in doc["metadata"] for doc in documents))


if __name__ == "__main__":
    unittest.main()

import unittest

from reranker import rerank_documents


class RerankerTests(unittest.TestCase):
    def test_default_reranker_preserves_pre_rank_and_scores_overlap(self):
        documents = [
            {
                "id": "chunk-low",
                "content": "Account settings page.",
                "retrieval_score": 0.9,
            },
            {
                "id": "chunk-hit",
                "content": "JSBridge connects WebView and Native runtime.",
                "retrieval_score": 0.7,
            },
        ]

        reranked = rerank_documents("JSBridge WebView Native", documents, top_k=2)

        self.assertEqual(reranked[0]["id"], "chunk-hit")
        self.assertEqual(reranked[0]["pre_rerank_rank"], 2)
        self.assertGreater(reranked[0]["rerank_score"], reranked[1]["rerank_score"])
        self.assertEqual(reranked[0]["reranker"], "local-overlap")


if __name__ == "__main__":
    unittest.main()

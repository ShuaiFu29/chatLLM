import unittest
from unittest.mock import patch

from graph_store import extract_graph_facts, search_graph


class GraphStoreTests(unittest.TestCase):
    def test_extract_graph_facts_builds_document_chunk_and_entity_links(self):
        facts = extract_graph_facts(
            {
                "id": "file-1",
                "user_id": "user-1",
                "project_space_id": "space-1",
                "filename": "webview.md",
            },
            [
                {
                    "id": "chunk-1",
                    "chunk_index": 0,
                    "content": "# WebView 原理\n\nJSBridge connects WebView and Native runtime.",
                },
            ],
        )

        self.assertEqual(facts["document"]["file_id"], "file-1")
        self.assertEqual(facts["chunks"][0]["chunk_id"], "chunk-1")
        entity_names = {entity["name"] for entity in facts["entities"]}
        self.assertIn("WebView", entity_names)
        self.assertIn("JSBridge", entity_names)
        self.assertIn("Native", entity_names)
        self.assertTrue(any(rel["type"] == "MENTIONS" for rel in facts["relationships"]))

    def test_search_graph_maps_neo4j_paths_to_rag_documents(self):
        neo4j_rows = [
            {
                "chunk_id": "chunk-1",
                "file_id": "file-1",
                "filename": "webview.md",
                "chunk_index": 2,
                "content": "JSBridge connects WebView and Native.",
                "entities": ["JSBridge", "WebView", "Native"],
                "graph_score": 3,
            },
        ]

        with patch("graph_store._run_cypher", return_value=neo4j_rows) as run_cypher:
            documents = search_graph(
                query="JSBridge 和 WebView 的关系",
                user_id="user-1",
                project_space_id="space-1",
                limit=5,
            )

        self.assertEqual(documents[0]["id"], "chunk-1")
        self.assertEqual(documents[0]["metadata"]["retrieval_mode"], "graph")
        self.assertEqual(documents[0]["metadata"]["graph_entities"], ["JSBridge", "WebView", "Native"])
        self.assertGreater(documents[0]["retrieval_score"], 0)
        params = run_cypher.call_args.args[1]
        self.assertEqual(params["user_id"], "user-1")
        self.assertEqual(params["project_space_id"], "space-1")


if __name__ == "__main__":
    unittest.main()

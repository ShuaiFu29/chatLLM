import unittest
from unittest.mock import patch

from graph_store import extract_graph_facts, index_graph_chunks, list_graph, search_graph


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

    def test_extract_graph_facts_infers_typed_relations_with_evidence(self):
        facts = extract_graph_facts(
            {
                "id": "file-1",
                "user_id": "user-1",
                "project_space_id": "space-1",
                "filename": "release.md",
            },
            [
                {
                    "id": "chunk-1",
                    "chunk_index": 0,
                    "content": "BMS策略依赖SOC校准数据。旧版T+7规则与新版T+5窗口冲突，召回证据支持质保结论。",
                },
            ],
        )

        typed_relationships = [
            rel for rel in facts["relationships"]
            if rel["type"] in {"DEPENDS_ON", "CONFLICTS_WITH", "SUPPORTS"}
        ]

        self.assertTrue(any(rel["type"] == "DEPENDS_ON" for rel in typed_relationships))
        self.assertTrue(any(rel["type"] == "CONFLICTS_WITH" for rel in typed_relationships))
        self.assertTrue(any(rel["type"] == "SUPPORTS" for rel in typed_relationships))
        self.assertTrue(all(rel["confidence"] >= 0.6 for rel in typed_relationships))
        self.assertTrue(all(rel["chunk_id"] == "chunk-1" for rel in typed_relationships))
        self.assertTrue(all(rel["evidence"] for rel in typed_relationships))

    def test_search_graph_maps_neo4j_paths_to_rag_documents(self):
        neo4j_rows = [
            {
                "chunk_id": "chunk-1",
                "file_id": "file-1",
                "filename": "webview.md",
                "chunk_index": 2,
                "content": "JSBridge connects WebView and Native.",
                "entities": ["JSBridge", "WebView", "Native"],
                "relations": [
                    {
                        "type": "DEPENDS_ON",
                        "from": "JSBridge",
                        "to": "Native",
                        "confidence": 0.72,
                        "evidence": "JSBridge connects WebView and Native.",
                    }
                ],
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
        self.assertEqual(documents[0]["metadata"]["graph_relations"][0]["type"], "DEPENDS_ON")
        self.assertEqual(documents[0]["metadata"]["graph_relations"][0]["confidence"], 0.72)
        self.assertGreater(documents[0]["retrieval_score"], 0)
        params = run_cypher.call_args.args[1]
        self.assertEqual(params["user_id"], "user-1")
        self.assertEqual(params["project_space_id"], "space-1")

    def test_list_graph_returns_overview_documents_without_query_terms(self):
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
            documents = list_graph(
                user_id="user-1",
                project_space_id="space-1",
                limit=5,
            )

        self.assertEqual(documents[0]["id"], "chunk-1")
        self.assertEqual(documents[0]["metadata"]["retrieval_mode"], "graph_overview")
        self.assertEqual(documents[0]["metadata"]["graph_entities"], ["JSBridge", "WebView", "Native"])
        self.assertGreater(documents[0]["retrieval_score"], 0)
        params = run_cypher.call_args.args[1]
        self.assertEqual(params["user_id"], "user-1")
        self.assertEqual(params["project_space_id"], "space-1")

    def test_graph_queries_keep_graph_score_after_optional_relation_match(self):
        neo4j_rows = [
            {
                "chunk_id": "chunk-1",
                "file_id": "file-1",
                "filename": "webview.md",
                "chunk_index": 2,
                "content": "JSBridge depends on Native.",
                "entities": ["JSBridge", "Native"],
                "relations": [],
                "graph_score": 2,
            },
        ]

        with patch("graph_store._run_cypher", return_value=neo4j_rows) as run_cypher:
            search_graph("JSBridge Native", "user-1", "space-1", 5)
            search_statement = run_cypher.call_args_list[0].args[0]

            list_graph("user-1", "space-1", 5)
            list_statement = run_cypher.call_args_list[1].args[0]

        self.assertIn("WITH c, entities, graph_score, collect(distinct", search_statement)
        self.assertIn("WITH c, entities, graph_score, collect(distinct", list_statement)
        self.assertIn("ORDER BY graph_score DESC", search_statement)
        self.assertIn("ORDER BY graph_score DESC, c.filename ASC, c.chunk_index ASC", list_statement)

    def test_index_graph_chunks_deduplicates_between_unwind_stages(self):
        file_data = {
            "id": "file-1",
            "user_id": "user-1",
            "project_space_id": "space-1",
            "filename": "risk.md",
        }
        chunk_rows = [
            {
                "id": "chunk-1",
                "chunk_index": 0,
                "content": "模型监控依赖灰度拒绝率，法务提示支持贷后动作。",
            },
            {
                "id": "chunk-2",
                "chunk_index": 1,
                "content": "G3客群与G2客群冲突，审批策略依赖名单修复。",
            },
        ]

        with patch("graph_store.ensure_graph_schema"), patch("graph_store._run_cypher") as run_cypher:
            index_graph_chunks(file_data, chunk_rows)

        write_statement = run_cypher.call_args.args[0]

        self.assertIn("WITH DISTINCT d\n            UNWIND $entities AS entity", write_statement)
        self.assertIn("WITH DISTINCT d\n            UNWIND $relationships AS rel", write_statement)


if __name__ == "__main__":
    unittest.main()

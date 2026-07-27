import unittest
from unittest.mock import patch

from graph_store import (
    _canonicalize_entities_with_registry,
    extract_graph_facts,
    index_graph_chunks,
    list_graph,
    search_graph,
)


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
        self.assertIn("Native runtime", entity_names)
        webview = next(entity for entity in facts["entities"] if entity["name"] == "WebView")
        self.assertEqual(webview["normalized_name"], "webview")
        self.assertEqual(webview["entity_type"], "Component")
        self.assertEqual(webview["ontology_version"], "core-v1")
        self.assertEqual(webview["extraction_method"], "identifier_pattern")
        self.assertEqual(webview["aliases"], ["WebView"])
        self.assertTrue(any(rel["type"] == "MENTIONS" for rel in facts["relationships"]))
        self.assertTrue(any(
            rel["type"] == "CONNECTS_TO"
            and rel["from"] == "JSBridge"
            and rel["to"] == "Native runtime"
            for rel in facts["relationships"]
        ))

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
                    "content": (
                        "BMS策略依赖SOC校准数据。旧版T+7规则与新版T+5窗口冲突，召回证据支持质保结论。"
                        "订单服务依赖 Redis 和 PostgreSQL。缓存如何影响消息处理？"
                    ),
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
        dependency_targets = {
            rel["to"] for rel in facts["relationships"]
            if rel["type"] == "DEPENDS_ON" and rel["from"] == "订单服务"
        }
        self.assertEqual(dependency_targets, {"Redis", "PostgreSQL"})
        self.assertTrue(any(
            rel["type"] == "IMPACTS"
            and rel["from"] == "缓存"
            and rel["to"] == "消息处理"
            for rel in facts["relationships"]
        ))
        self.assertTrue(all("confidence" not in rel for rel in typed_relationships))
        self.assertTrue(all(rel["extraction_method"] == "regex_rule" for rel in typed_relationships))
        self.assertTrue(all(rel["extraction_lane"] == "fallback" for rel in typed_relationships))
        self.assertTrue(all(rel["pattern_id"] for rel in typed_relationships))
        self.assertTrue(all(rel["from_normalized"] and rel["to_normalized"] for rel in typed_relationships))
        self.assertTrue(all(rel["chunk_id"] == "chunk-1" for rel in typed_relationships))
        self.assertTrue(all(rel["evidence"] for rel in typed_relationships))

    def test_extract_graph_facts_rejects_pronoun_and_sentence_fragment_entities(self):
        facts = extract_graph_facts(
            {
                "id": "file-1",
                "user_id": "user-1",
                "project_space_id": "space-1",
                "filename": "noise.md",
            },
            [{
                "id": "chunk-1",
                "chunk_index": 0,
                "content": "这是普通说明文字，不应把每个英文 word 或连续中文句子入图。它依赖该。",
            }],
        )

        entity_names = {entity["name"] for entity in facts["entities"]}
        self.assertNotIn("word", entity_names)
        self.assertNotIn("这是普通说明文字", entity_names)
        self.assertFalse(any(rel["type"] == "DEPENDS_ON" for rel in facts["relationships"]))

    def test_extract_graph_facts_deduplicates_aliases_by_normalized_name(self):
        facts = extract_graph_facts(
            {
                "id": "file-1",
                "user_id": "user-1",
                "project_space_id": "space-1",
                "filename": "aliases.md",
            },
            [{
                "id": "chunk-1",
                "chunk_index": 0,
                "content": "# Runtime\n`JSBridge` depends on `jsbridge`.",
            }],
        )

        jsbridge_entities = [
            entity for entity in facts["entities"]
            if entity["normalized_name"] == "jsbridge"
        ]
        self.assertEqual(len(jsbridge_entities), 1)
        self.assertEqual(set(jsbridge_entities[0]["aliases"]), {"JSBridge", "jsbridge"})

    def test_unique_canonical_alias_match_reuses_existing_entity_and_rewrites_edges(self):
        facts = {
            "entities": [{
                "name": "Redis缓存",
                "normalized_name": "redis缓存",
                "aliases": ["Redis缓存", "Redis"],
                "entity_type": "Component",
            }],
            "relationships": [{
                "type": "MENTIONS",
                "from": "chunk-1",
                "to": "Redis缓存",
                "to_normalized": "redis缓存",
            }],
        }
        existing = [{
            "name": "Redis",
            "normalized_name": "redis",
            "aliases": ["Redis"],
            "entity_type": "Database",
        }]

        canonical = _canonicalize_entities_with_registry(facts, existing)

        self.assertEqual(len(canonical["entities"]), 1)
        self.assertEqual(canonical["entities"][0]["normalized_name"], "redis")
        self.assertEqual(set(canonical["entities"][0]["aliases"]), {"Redis", "Redis缓存"})
        self.assertEqual(canonical["relationships"][0]["to"], "Redis")
        self.assertEqual(canonical["relationships"][0]["to_normalized"], "redis")

    def test_ambiguous_alias_does_not_merge_distinct_existing_entities(self):
        facts = {
            "entities": [{
                "name": "API",
                "normalized_name": "api",
                "aliases": ["API", "Application Interface"],
                "entity_type": "API",
            }],
            "relationships": [],
        }
        existing = [
            {"name": "Billing API", "normalized_name": "billing api", "aliases": ["API"]},
            {"name": "Search API", "normalized_name": "search api", "aliases": ["API"]},
        ]

        canonical = _canonicalize_entities_with_registry(facts, existing)

        self.assertEqual(canonical["entities"][0]["normalized_name"], "api")
        self.assertEqual(canonical["entities"][0]["name"], "API")

    def test_search_graph_traverses_bounded_two_hop_paths_and_returns_evidence_features(self):
        seed_rows = [{
            "normalized_name": "redis",
            "scope_key": "space-1",
            "name": "Redis",
            "seed_match_score": 1.0,
        }]
        first_hop = [{
            "current_normalized_name": "redis",
            "scope_key": "space-1",
            "neighbor_normalized_name": "queue",
            "neighbor_name": "Queue",
            "neighbor_degree": 2,
            "relation": {
                "type": "CONNECTS_TO",
                "from": "Redis",
                "to": "Queue",
                "evidence": "Redis connects to Queue.",
                "evidence_chunk_ids": ["chunk-1"],
                "evidence_spans": ["Redis connects to Queue."],
                "extraction_method": "llm_json",
                "extractors": ["llm_json:llm-json-v1"],
            },
        }]
        second_hop = [{
            "current_normalized_name": "queue",
            "scope_key": "space-1",
            "neighbor_normalized_name": "worker",
            "neighbor_name": "Worker",
            "neighbor_degree": 1,
            "relation": {
                "type": "CONNECTS_TO",
                "from": "Queue",
                "to": "Worker",
                "evidence": "Queue forwards jobs to Worker.",
                "evidence_chunk_ids": ["chunk-2"],
                "evidence_spans": ["Queue forwards jobs to Worker."],
                "extraction_method": "llm_json",
                "extractors": ["llm_json:llm-json-v1"],
            },
        }]
        evidence_rows = [
            {
                "chunk_id": "chunk-1",
                "file_id": "file-1",
                "filename": "queue.md",
                "chunk_index": 1,
                "content": "Redis connects to Queue.",
            },
            {
                "chunk_id": "chunk-2",
                "file_id": "file-1",
                "filename": "queue.md",
                "chunk_index": 2,
                "content": "Queue forwards jobs to Worker.",
            },
        ]

        with patch(
            "graph_store._run_cypher",
            side_effect=[seed_rows, first_hop, second_hop, [], evidence_rows],
        ) as run_cypher:
            documents = search_graph(
                query="Redis 和 Worker 的关系",
                user_id="user-1",
                project_space_id="space-1",
                limit=5,
                max_hops=3,
                max_branch_factor=4,
                max_paths=8,
            )

        self.assertEqual(documents[0]["id"], "chunk-1")
        self.assertEqual(documents[0]["metadata"]["retrieval_mode"], "graph")
        self.assertIn("Worker", documents[0]["metadata"]["graph_entities"])
        self.assertEqual(documents[0]["metadata"]["graph_relations"][0]["type"], "CONNECTS_TO")
        self.assertNotIn("confidence", documents[0]["metadata"]["graph_relations"][0])
        self.assertEqual(documents[0]["metadata"]["graph_seed_entities"], ["Redis"])
        self.assertTrue(any(
            path["features"]["path_length"] == 2
            for path in documents[0]["metadata"]["graph_paths"]
        ))
        self.assertIn("graph_rank_score", documents[0])
        self.assertNotIn("graph_score", documents[0])
        self.assertGreater(documents[0]["retrieval_score"], 0)
        self.assertEqual(run_cypher.call_count, 5)
        expansion_params = run_cypher.call_args_list[1].args[1]
        self.assertEqual(expansion_params["max_branch_factor"], 4)
        evidence_params = run_cypher.call_args_list[-1].args[1]
        self.assertEqual(evidence_params["chunk_ids"], ["chunk-1", "chunk-2"])

    def test_search_graph_uses_clean_entities_from_chinese_impact_question(self):
        with patch("graph_store._run_cypher", return_value=[]) as run_cypher:
            search_graph(
                query="缓存如何影响消息处理？",
                user_id="user-1",
                project_space_id="space-1",
                limit=5,
            )

        self.assertEqual(run_cypher.call_args.args[1]["terms"], ["消息处理", "缓存"])

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

        with patch("graph_store.ensure_graph_schema"), patch(
            "graph_store._neo4j_request",
            side_effect=[
                {"commit": "http://localhost:7474/db/neo4j/tx/7/commit"},
                {"results": [], "errors": []},
            ],
        ) as neo4j_request:
            index_graph_chunks(file_data, chunk_rows)

        write_statement = neo4j_request.call_args_list[0].args[1][0]["statement"]

        self.assertIn("WITH DISTINCT d\nUNWIND $entities AS entity", write_statement)
        self.assertIn("WITH DISTINCT d\nUNWIND $relationships AS rel", write_statement)
        self.assertIn("normalized_name: entity.normalized_name", write_statement)
        self.assertNotIn("typed.confidence", write_statement)


if __name__ == "__main__":
    unittest.main()

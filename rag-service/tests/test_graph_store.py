import unittest
from unittest.mock import patch

from config import settings

from graph_store import (
    _canonicalize_entities_with_registry,
    check_graph_store_ready,
    extract_graph_facts,
    index_graph_chunks,
    list_graph,
    search_graph,
)


class GraphStoreTests(unittest.TestCase):
    def test_graph_store_readiness_reports_recent_extraction_quality(self):
        with patch.object(settings, "neo4j_enabled", True), patch(
            "graph_store._run_cypher",
            side_effect=[
                [{"ok": True}],
                [{"document_count": 4, "attempted": 10, "succeeded": 2, "fallbacks": 8}],
            ],
        ) as run_cypher:
            status = check_graph_store_ready()

        self.assertTrue(status["ready"])
        self.assertEqual(status["runtime_quality"]["status"], "degraded")
        self.assertEqual(status["runtime_quality"]["success_rate"], 0.2)
        self.assertEqual(status["runtime_quality"]["fallback_rate"], 0.8)
        self.assertEqual(run_cypher.call_count, 2)

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
        self.assertEqual(webview["ontology_version"], settings.graph_ontology_version)
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

    def test_chinese_compound_predicates_do_not_leak_into_entity_names(self):
        facts = extract_graph_facts(
            {
                "id": "file-contract",
                "user_id": "user-1",
                "project_space_id": "space-1",
                "filename": "合同职责.md",
            },
            [{
                "id": "chunk-contract",
                "chunk_index": 0,
                "content": "订单服务依赖Redis并连接到Kafka。甲方负责项目验收，乙方负责系统交付。张伟负责客户资料审核。",
            }],
        )

        relations = [relation for relation in facts["relationships"] if relation.get("fact_id")]
        triples = {(item["type"], item["from"], item["to"]) for item in relations}
        self.assertIn(("DEPENDS_ON", "订单服务", "Redis"), triples)
        self.assertIn(("CONNECTS_TO", "订单服务", "Kafka"), triples)
        self.assertIn(("RESPONSIBLE_FOR", "甲方", "项目验收"), triples)
        self.assertIn(("RESPONSIBLE_FOR", "乙方", "系统交付"), triples)
        self.assertIn(("RESPONSIBLE_FOR", "张伟", "客户资料审核"), triples)
        self.assertNotIn("Redis并连接到Kafka", {entity["name"] for entity in facts["entities"]})
        self.assertTrue(all(item["fact_id"].startswith("kgfact_") for item in relations))
        self.assertTrue(all(item["from_entity_id"].startswith("kgent_") for item in relations))

    def test_fact_identity_preserves_negated_and_planned_statements(self):
        facts = extract_graph_facts(
            {
                "id": "file-policy",
                "user_id": "user-1",
                "project_space_id": "space-1",
                "filename": "策略.md",
            },
            [{
                "id": "chunk-policy",
                "chunk_index": 0,
                "content": "订单服务不依赖Redis。订单服务计划依赖Redis。",
            }],
        )

        relations = [
            relation for relation in facts["relationships"]
            if relation.get("type") == "DEPENDS_ON"
        ]
        self.assertEqual(len(relations), 2)
        self.assertEqual(len({relation["fact_id"] for relation in relations}), 2)
        self.assertEqual({relation["polarity"] for relation in relations}, {"negative", "affirmative"})
        self.assertIn("planned_or_obligatory", {relation["modality"] for relation in relations})

    def test_same_surface_in_different_documents_has_distinct_entity_identity(self):
        base = {"user_id": "user-1", "project_space_id": "space-1", "filename": "x.md"}
        first = extract_graph_facts(
            {**base, "id": "file-a"},
            [{"id": "chunk-a", "chunk_index": 0, "content": "张伟负责合同审核。"}],
        )
        second = extract_graph_facts(
            {**base, "id": "file-b"},
            [{"id": "chunk-b", "chunk_index": 0, "content": "张伟负责客户沟通。"}],
        )
        first_zhang = next(entity for entity in first["entities"] if entity["name"] == "张伟")
        second_zhang = next(entity for entity in second["entities"] if entity["name"] == "张伟")
        self.assertNotEqual(first_zhang["entity_id"], second_zhang["entity_id"])
        self.assertEqual(first_zhang["identity_scope"], "document")

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
            "entity_id": "entity-redis",
            "normalized_name": "redis",
            "scope_key": "space-1",
            "name": "Redis",
            "entity_type": "Technology",
            "entity_type_label": "Database",
            "aliases": ["Redis DB"],
            "seed_match_score": 1.0,
        }]
        first_hop = [{
            "current_entity_id": "entity-redis",
            "current_normalized_name": "redis",
            "scope_key": "space-1",
            "neighbor_entity_id": "entity-queue",
            "neighbor_normalized_name": "queue",
            "neighbor_name": "Queue",
            "neighbor_entity_type": "Component",
            "neighbor_entity_type_label": "Queue",
            "neighbor_degree": 2,
            "relation": {
                "type": "CONNECTS_TO",
                "from": "Redis",
                "to": "Queue",
                "from_entity_id": "entity-redis",
                "to_entity_id": "entity-queue",
                "evidence": "Redis connects to Queue.",
                "evidence_chunk_ids": ["chunk-1"],
                "evidence_spans": ["Redis connects to Queue."],
                "extraction_method": "llm_json",
                "extractors": ["llm_json:llm-json-v1"],
            },
        }]
        second_hop = [{
            "current_entity_id": "entity-queue",
            "current_normalized_name": "queue",
            "scope_key": "space-1",
            "neighbor_entity_id": "entity-worker",
            "neighbor_normalized_name": "worker",
            "neighbor_name": "Worker",
            "neighbor_entity_type": "Component",
            "neighbor_entity_type_label": "Service",
            "neighbor_degree": 1,
            "relation": {
                "type": "CONNECTS_TO",
                "from": "Queue",
                "to": "Worker",
                "from_entity_id": "entity-queue",
                "to_entity_id": "entity-worker",
                "evidence": "Queue forwards jobs to Worker.",
                "evidence_chunk_ids": ["chunk-2"],
                "evidence_spans": ["Queue forwards jobs to Worker."],
                "extraction_method": "llm_json",
                "extractors": ["llm_json:llm-json-v1"],
            },
        }]
        evidence_rows = [
            {
                "id": "chunk-1",
                "file_id": "file-1",
                "filename": "queue.md",
                "chunk_index": 1,
                "content": "Redis connects to Queue.",
                "metadata": {"filename": "queue.md"},
                "document_kind": "markdown",
                "conversion_generation_id": None,
                "source_unit_ids": [],
                "source_locator": {"type": "markdown", "line_start": 1, "line_end": 1},
            },
            {
                "id": "chunk-2",
                "file_id": "file-1",
                "filename": "queue.md",
                "chunk_index": 2,
                "content": "Queue forwards jobs to Worker.",
                "metadata": {"filename": "queue.md"},
                "document_kind": "markdown",
                "conversion_generation_id": None,
                "source_unit_ids": [],
                "source_locator": {"type": "markdown", "line_start": 2, "line_end": 2},
            },
        ]

        with patch(
            "graph_store._run_cypher",
            side_effect=[seed_rows, first_hop, second_hop, []],
        ) as run_cypher, patch(
            "graph_store.get_active_chunks_by_ids",
            return_value=evidence_rows,
        ) as hydrate_chunks:
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
        self.assertEqual(set(documents[0]["metadata"]["graph_entities"]), {"Redis", "Queue"})
        self.assertEqual(documents[0]["metadata"]["graph_relations"][0]["type"], "CONNECTS_TO")
        self.assertTrue(all(
            "chunk-1" in relation["evidence_chunk_ids"]
            for relation in documents[0]["metadata"]["graph_relations"]
        ))
        chunk_two = next(document for document in documents if document["id"] == "chunk-2")
        self.assertTrue(all(
            "chunk-2" in relation["evidence_chunk_ids"]
            for relation in chunk_two["metadata"]["graph_relations"]
        ))
        self.assertFalse(any(
            relation["to"] == "Worker"
            for relation in documents[0]["metadata"]["graph_relations"]
        ))
        self.assertEqual(
            {entity["entity_id"] for entity in documents[0]["metadata"]["graph_entity_details"]},
            {"entity-redis", "entity-queue"},
        )
        self.assertEqual(
            {entity["entity_id"] for entity in chunk_two["metadata"]["graph_entity_details"]},
            {"entity-queue", "entity-worker"},
        )
        self.assertNotIn("confidence", documents[0]["metadata"]["graph_relations"][0])
        self.assertEqual(documents[0]["metadata"]["graph_seed_entities"], ["Redis"])
        self.assertTrue(any(
            path["features"]["path_length"] == 2
            for path in documents[0]["metadata"]["graph_paths"]
        ))
        self.assertIn("graph_rank_score", documents[0])
        self.assertNotIn("graph_score", documents[0])
        self.assertGreater(documents[0]["retrieval_score"], 0)
        self.assertEqual(run_cypher.call_count, 4)
        expansion_params = run_cypher.call_args_list[1].args[1]
        self.assertEqual(expansion_params["max_branch_factor"], 4)
        self.assertEqual(hydrate_chunks.call_count, 3)
        self.assertEqual(
            hydrate_chunks.call_args_list[-1].args,
            (["chunk-1", "chunk-2"], "user-1", "space-1"),
        )
        self.assertEqual(
            documents[0]["metadata"]["source_locator"],
            {"type": "markdown", "line_start": 1, "line_end": 1},
        )

        with patch(
            "graph_store._run_cypher",
            side_effect=[seed_rows, first_hop, second_hop, []],
        ), patch(
            "graph_store.get_active_chunks_by_ids",
            return_value=evidence_rows[:1],
        ):
            filtered_documents = search_graph(
                query="Redis 和 Worker 的关系",
                user_id="user-1",
                project_space_id="space-1",
                limit=5,
                max_hops=3,
                max_branch_factor=4,
                max_paths=8,
            )

        self.assertTrue(filtered_documents)
        self.assertTrue(all(
            path["features"]["path_length"] == 1
            for document in filtered_documents
            for path in document["metadata"]["graph_paths"]
        ))

    def test_search_graph_uses_clean_entities_from_chinese_impact_question(self):
        with patch("graph_store._run_cypher", return_value=[]) as run_cypher:
            search_graph(
                query="缓存如何影响消息处理？",
                user_id="user-1",
                project_space_id="space-1",
                limit=5,
            )

        self.assertEqual(run_cypher.call_args.args[1]["terms"], ["消息处理", "缓存"])

    def test_search_graph_extracts_entity_from_responsibility_question(self):
        with patch("graph_store._run_cypher", return_value=[]) as run_cypher:
            search_graph(
                query="张伟负责什么？",
                user_id="user-1",
                project_space_id="space-1",
                limit=5,
            )

        self.assertEqual(run_cypher.call_args.args[1]["terms"], ["张伟"])

    def test_search_graph_pages_past_stale_edges_before_applying_branch_limit(self):
        seed_rows = [{
            "normalized_name": "gateway",
            "scope_key": "space-1",
            "name": "Gateway",
            "seed_match_score": 1.0,
        }]

        def edge(chunk_id, neighbor):
            return [{
                "current_normalized_name": "gateway",
                "scope_key": "space-1",
                "neighbor_normalized_name": neighbor.lower(),
                "neighbor_name": neighbor,
                "neighbor_degree": 1,
                "relation": {
                    "type": "USES",
                    "from": "Gateway",
                    "to": neighbor,
                    "evidence": f"Gateway uses {neighbor}.",
                    "evidence_chunk_ids": [chunk_id],
                    "evidence_spans": [f"Gateway uses {neighbor}."],
                    "extraction_method": "llm_json",
                    "extraction_lane": "primary",
                },
            }]

        active_chunk = {
            "id": "active-chunk",
            "file_id": "file-1",
            "filename": "active.md",
            "chunk_index": 1,
            "content": "Gateway uses CurrentWorker.",
            "metadata": {},
            "document_kind": "markdown",
            "conversion_generation_id": None,
            "source_unit_ids": [],
            "source_locator": {"type": "markdown", "line_start": 1, "line_end": 1},
        }

        with patch(
            "graph_store._run_cypher",
            side_effect=[seed_rows, edge("stale-chunk", "OldWorker"), edge("active-chunk", "CurrentWorker")],
        ) as run_cypher, patch(
            "graph_store.get_active_chunks_by_ids",
            side_effect=[[], [active_chunk], [active_chunk]],
        ):
            documents = search_graph(
                "Gateway 和 CurrentWorker 的关系",
                "user-1",
                "space-1",
                limit=1,
                max_hops=1,
                max_branch_factor=1,
            )

        self.assertEqual([document["id"] for document in documents], ["active-chunk"])
        self.assertEqual(
            documents[0]["metadata"]["graph_relations"][0]["to"],
            "CurrentWorker",
        )
        self.assertEqual(run_cypher.call_args_list[1].args[1]["edge_offset"], 0)
        self.assertEqual(run_cypher.call_args_list[2].args[1]["edge_offset"], 1)

    def test_list_graph_returns_overview_documents_without_query_terms(self):
        neo4j_rows = [
            {
                "chunk_id": "chunk-1",
                "entities": ["JSBridge", "WebView", "Native"],
                "entity_details": [{
                    "entity_id": "entity-jsbridge",
                    "name": "JSBridge",
                    "entity_type": "Technology",
                    "entity_type_label": "Bridge",
                    "aliases": [],
                }],
                "graph_score": 3,
            },
        ]
        active_chunks = [{
            "id": "chunk-1",
            "file_id": "file-1",
            "filename": "canonical.md",
            "chunk_index": 2,
            "content": "Canonical PostgreSQL evidence.",
            "metadata": {},
            "project_space_id": "space-1",
            "document_kind": "pdf",
            "conversion_generation_id": "generation-1",
            "source_unit_ids": ["u_0123456789abcdef0123456789abcdef"],
            "source_locator": {"type": "pdf", "page_start": 4, "page_end": 4},
        }]

        with patch("graph_store._run_cypher", return_value=neo4j_rows) as run_cypher, patch(
            "graph_store.get_active_chunks_by_ids",
            return_value=active_chunks,
        ) as hydrate_chunks:
            documents = list_graph(
                user_id="user-1",
                project_space_id="space-1",
                limit=5,
            )

        self.assertEqual(documents[0]["id"], "chunk-1")
        self.assertEqual(documents[0]["content"], "Canonical PostgreSQL evidence.")
        self.assertEqual(documents[0]["metadata"]["filename"], "canonical.md")
        self.assertEqual(documents[0]["metadata"]["source_locator"]["page_start"], 4)
        self.assertEqual(documents[0]["metadata"]["retrieval_mode"], "graph_overview")
        self.assertEqual(documents[0]["metadata"]["graph_entities"], ["JSBridge", "WebView", "Native"])
        self.assertEqual(
            documents[0]["metadata"]["graph_entity_details"][0]["entity_id"],
            "entity-jsbridge",
        )
        self.assertGreater(documents[0]["retrieval_score"], 0)
        params = run_cypher.call_args.args[1]
        self.assertEqual(params["user_id"], "user-1")
        self.assertEqual(params["project_space_id"], "space-1")
        self.assertEqual(params["limit"], 25)
        self.assertNotIn("content: c.content", run_cypher.call_args.args[0])
        self.assertIn("entity_details", run_cypher.call_args.args[0])
        self.assertIn("from_entity_id", run_cypher.call_args.args[0])
        hydrate_chunks.assert_called_once_with(
            ["chunk-1"],
            "user-1",
            "space-1",
        )

    def test_list_graph_drops_candidates_rejected_by_postgres_authority(self):
        with patch("graph_store._run_cypher", return_value=[{
            "chunk_id": "stale-chunk",
            "entities": ["Old"],
            "graph_rank_score": 1,
        }]), patch("graph_store.get_active_chunks_by_ids", return_value=[]):
            documents = list_graph("user-1", "space-1", limit=5)

        self.assertEqual(documents, [])

    def test_list_graph_pages_until_active_generation_fills_limit(self):
        stale_rows = [
            {
                "chunk_id": f"stale-{index}",
                "entities": [f"Old-{index}"],
                "graph_rank_score": 100 - index,
            }
            for index in range(5)
        ]
        active_row = {
            "chunk_id": "active-chunk",
            "entities": ["Current"],
            "graph_rank_score": 1,
        }
        active_chunk = {
            "id": "active-chunk",
            "file_id": "file-1",
            "filename": "current.md",
            "chunk_index": 1,
            "content": "Current evidence.",
            "metadata": {},
            "project_space_id": "space-1",
            "document_kind": "markdown",
            "conversion_generation_id": None,
            "source_unit_ids": [],
            "source_locator": {"type": "markdown", "line_start": 1, "line_end": 1},
        }

        with patch(
            "graph_store._run_cypher", side_effect=[stale_rows, [active_row]],
        ) as run_cypher, patch(
            "graph_store.get_active_chunks_by_ids", side_effect=[[], [active_chunk]],
        ):
            documents = list_graph("user-1", "space-1", limit=1)

        self.assertEqual([document["id"] for document in documents], ["active-chunk"])
        self.assertEqual(run_cypher.call_count, 2)
        self.assertEqual(run_cypher.call_args_list[0].args[1]["offset"], 0)
        self.assertEqual(run_cypher.call_args_list[1].args[1]["offset"], 5)

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

        self.assertIn("CALL {\n  WITH d\n  UNWIND $entities AS entity", write_statement)
        self.assertIn("CALL {\n  WITH d\n  UNWIND $relationships AS rel", write_statement)
        self.assertIn("RETURN count(*) AS cached_extractions", write_statement)
        self.assertIn("MERGE (e:Entity {entity_id: entity.entity_id})", write_statement)
        self.assertIn("MERGE (fact:Fact {fact_id: rel.fact_id})", write_statement)
        self.assertIn("MERGE (fromEntity)-[typed:RELATED_TO {fact_id: rel.fact_id}]->(toEntity)", write_statement)
        self.assertNotIn("typed.confidence", write_statement)

    def test_cache_preload_uses_same_provider_fingerprint_as_extraction(self):
        file_data = {
            "id": "file-1",
            "user_id": "user-1",
            "project_space_id": "space-1",
            "filename": "cache.md",
        }
        rows = [{"id": "chunk-1", "chunk_index": 0, "content": "Gateway connects Worker."}]
        minimal_facts = {
            "document": {
                "file_id": "file-1",
                "user_id": "user-1",
                "scope_key": "space-1",
            },
            "chunks": [],
            "entities": [],
            "relationships": [],
            "extractions": [],
            "extraction_stats": {
                "attempted": 1,
                "succeeded": 1,
                "cache_hits": 0,
                "fallbacks": 0,
                "failure_reasons": {},
            },
            "graph_cache_ttl_days": 30,
        }

        with patch.object(settings, "graph_extraction_enabled", True), patch(
            "graph_store.ensure_graph_schema"
        ), patch(
            "graph_store.graph_extraction_fingerprint", return_value="provider-fingerprint"
        ), patch(
            "graph_store._load_graph_extraction_cache", return_value={}
        ) as load_cache, patch(
            "graph_store.extract_graph_facts", return_value=minimal_facts
        ), patch(
            "graph_store._neo4j_request",
            side_effect=[
                {"commit": "http://localhost:7474/db/neo4j/tx/8/commit"},
                {"results": [], "errors": []},
            ],
        ):
            index_graph_chunks(file_data, rows)

        self.assertEqual(load_cache.call_args.args[1], "provider-fingerprint")


if __name__ == "__main__":
    unittest.main()

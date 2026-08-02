import unittest
from unittest.mock import patch

import graph_extraction

from graph_extraction import (
    GraphExtractionError,
    build_chunk_windows,
    extraction_cache_key,
    graph_extraction_fingerprint,
    infer_relation_qualifiers,
    validate_graph_extraction,
    window_content_hash,
)
from graph_store import extract_graph_facts


def grounded_payload():
    return {
        "entities": [
            {"name": "Redis", "type": "Database", "aliases": ["Redis DB"]},
            {"name": "Worker", "type": "Service", "aliases": []},
        ],
        "mentions": [
            {
                "entity": "Redis",
                "surface": "Redis",
                "chunk_id": "previous_1",
                "evidence_span": "Redis accepts jobs.",
            },
            {
                "entity": "Worker",
                "surface": "Worker",
                "chunk_id": "target",
                "evidence_span": "它 forwards them to Worker.",
            },
        ],
        "relations": [
            {
                "source": "Redis",
                "target": "Worker",
                "type": "CONNECTS_TO",
                "evidence": [
                    {"chunk_id": "previous_1", "span": "Redis accepts jobs."},
                    {"chunk_id": "target", "span": "它 forwards them to Worker."},
                ],
            },
        ],
        "coreferences": [
            {
                "mention": "它",
                "entity": "Redis",
                "chunk_id": "target",
                "evidence_span": "它 forwards them to Worker.",
            },
        ],
    }


class GraphExtractionTests(unittest.TestCase):
    def test_related_to_rejects_conjunctions_and_cooccurrence_labels(self):
        evidence = ["Gateway and Worker are listed together."]

        self.assertFalse(graph_extraction._relation_is_semantically_supported(
            "RELATED_TO", "and", evidence,
        ))
        self.assertFalse(graph_extraction._relation_is_semantically_supported(
            "RELATED_TO", "listed together", evidence,
        ))
        self.assertFalse(graph_extraction._relation_is_semantically_supported(
            "DEPENDS_ON", "and", evidence,
        ))

    def test_english_qualifiers_require_whole_words(self):
        for evidence in (
            "Gateway differs from Worker.",
            "Gateway has a notable impact on Worker.",
            "The notification references Worker.",
            "A whenable adapter is described.",
        ):
            with self.subTest(evidence=evidence):
                self.assertEqual(
                    infer_relation_qualifiers([evidence]),
                    ("affirmative", "asserted"),
                )

        self.assertEqual(
            infer_relation_qualifiers(["Gateway does not use Worker."]),
            ("negative", "asserted"),
        )
        self.assertEqual(
            infer_relation_qualifiers(["Gateway uses Worker if Queue is unavailable."]),
            ("affirmative", "conditional"),
        )

    def test_cache_fingerprint_changes_with_actual_graph_model(self):
        with patch.object(graph_extraction.settings, "graph_extraction_model", "model-a"):
            first = graph_extraction_fingerprint()
        with patch.object(graph_extraction.settings, "graph_extraction_model", "model-b"):
            second = graph_extraction_fingerprint()

        self.assertNotEqual(first, second)

    def test_same_section_window_is_bounded_and_cache_identity_survives_new_chunk_ids(self):
        rows = [
            {"id": "old-a", "chunk_index": 0, "content": "# Reliability\n\nRedis accepts jobs."},
            {"id": "old-b", "chunk_index": 1, "content": "# Reliability\n\n它 forwards them to Worker."},
            {"id": "old-c", "chunk_index": 2, "content": "# Deployment\n\nDifferent section."},
        ]
        window = build_chunk_windows([rows[1]], context_rows=[rows[0], rows[2]], radius=1)[0]

        self.assertEqual([chunk["chunk_id"] for chunk in window["chunks"]], ["previous_1", "target"])
        self.assertEqual(window["section_path"], ["Reliability"])

        rebuilt_rows = [
            {**rows[0], "id": "new-a"},
            {**rows[1], "id": "new-b"},
        ]
        rebuilt = build_chunk_windows([rebuilt_rows[1]], context_rows=[rebuilt_rows[0]], radius=1)[0]
        self.assertEqual(window_content_hash(window), window_content_hash(rebuilt))

    def test_validation_accepts_grounded_cross_chunk_coreference_without_probability(self):
        rows = [
            {"id": "chunk-a", "chunk_index": 0, "content": "# Reliability\n\nRedis accepts jobs."},
            {"id": "chunk-b", "chunk_index": 1, "content": "# Reliability\n\n它 forwards them to Worker."},
        ]
        window = build_chunk_windows([rows[1]], context_rows=[rows[0]], radius=1)[0]

        result = validate_graph_extraction(
            grounded_payload(),
            window,
            extractor_version="llm-json-v1",
            ontology_version="core-v1",
        )

        relation = result["relations"][0]
        self.assertEqual(relation["evidence_chunk_ids"], ["previous_1", "target"])
        self.assertEqual(relation["ontology_version"], "core-v1")
        self.assertNotIn("confidence", relation)

    def test_validation_rejects_fabricated_evidence_and_ambiguous_aliases(self):
        rows = [{"id": "chunk-a", "chunk_index": 0, "content": "Gateway connects Worker."}]
        window = build_chunk_windows(rows, radius=1)[0]
        fabricated = {
            "entities": [
                {"name": "Gateway", "type": "Service", "aliases": []},
                {"name": "Worker", "type": "Service", "aliases": []},
            ],
            "mentions": [
                {"entity": "Gateway", "surface": "Gateway", "chunk_id": "target", "evidence_span": "Gateway connects Worker."},
                {"entity": "Worker", "surface": "Worker", "chunk_id": "target", "evidence_span": "Gateway connects Worker."},
            ],
            "relations": [{
                "source": "Gateway",
                "target": "Worker",
                "type": "CONNECTS_TO",
                "evidence": [{"chunk_id": "target", "span": "Gateway secretly depends on Worker."}],
            }],
            "coreferences": [],
        }
        with self.assertRaises(GraphExtractionError):
            validate_graph_extraction(
                fabricated,
                window,
                extractor_version="llm-json-v1",
                ontology_version="core-v1",
            )

        ambiguous = {
            "entities": [
                {"name": "API Gateway", "type": "Service", "aliases": ["Gateway"]},
                {"name": "Message Gateway", "type": "Service", "aliases": ["Gateway"]},
            ],
            "mentions": [
                {"entity": "API Gateway", "surface": "Gateway", "chunk_id": "target", "evidence_span": "Gateway connects Worker."},
                {"entity": "Message Gateway", "surface": "Gateway", "chunk_id": "target", "evidence_span": "Gateway connects Worker."},
            ],
            "relations": [],
            "coreferences": [],
        }
        ambiguous["mentions"][0]["entity"] = "Gateway"
        with self.assertRaises(GraphExtractionError):
            validate_graph_extraction(
                ambiguous,
                window,
                extractor_version="llm-json-v1",
                ontology_version="core-v1",
            )

    def test_validation_rejects_relation_inferred_from_cooccurrence_only(self):
        rows = [{"id": "chunk-a", "chunk_index": 0, "content": "Gateway and Worker are listed together."}]
        window = build_chunk_windows(rows, radius=1)[0]
        payload = {
            "entities": [
                {"name": "Gateway", "type": "Service", "aliases": []},
                {"name": "Worker", "type": "Service", "aliases": []},
            ],
            "mentions": [
                {"entity": "Gateway", "surface": "Gateway", "chunk_id": "target", "evidence_span": rows[0]["content"]},
                {"entity": "Worker", "surface": "Worker", "chunk_id": "target", "evidence_span": rows[0]["content"]},
            ],
            "relations": [{
                "source": "Gateway",
                "target": "Worker",
                "type": "DEPENDS_ON",
                "evidence": [{"chunk_id": "target", "span": rows[0]["content"]}],
            }],
            "coreferences": [],
        }

        with self.assertRaisesRegex(GraphExtractionError, "predicate is not supported"):
            validate_graph_extraction(
                payload,
                window,
                extractor_version="llm-json-v2",
                ontology_version="core-v2",
            )

    def test_entity_keys_disambiguate_identical_surface_names(self):
        content = "两项均名为星云：星云公司提供星云产品。"
        rows = [{"id": "chunk-a", "chunk_index": 0, "content": content}]
        payload = {
            "entities": [
                {"entity_key": "nebula-company", "name": "星云", "type": "Organization", "type_label": "公司", "aliases": []},
                {"entity_key": "nebula-product", "name": "星云", "type": "Product", "type_label": "产品", "aliases": []},
            ],
            "mentions": [
                {"entity": "nebula-company", "surface": "星云", "chunk_id": "target", "evidence_span": "星云公司提供星云产品。"},
                {"entity": "nebula-product", "surface": "星云", "chunk_id": "target", "evidence_span": "星云公司提供星云产品。"},
            ],
            "relations": [{
                "source": "nebula-company",
                "target": "nebula-product",
                "type": "PROVIDES",
                "label": "提供",
                "evidence": [{"chunk_id": "target", "span": "星云公司提供星云产品。"}],
            }],
            "coreferences": [],
        }
        facts = extract_graph_facts(
            {"id": "file-a", "user_id": "user-a", "project_space_id": "space-a", "filename": "产品.md"},
            rows,
            extraction_provider=lambda _window: payload,
        )

        nebula_entities = [entity for entity in facts["entities"] if entity["name"] == "星云"]
        self.assertEqual(len(nebula_entities), 2)
        self.assertEqual(len({entity["entity_id"] for entity in nebula_entities}), 2)
        relation = next(item for item in facts["relationships"] if item.get("type") == "PROVIDES")
        self.assertNotEqual(relation["from_entity_id"], relation["to_entity_id"])

    def test_invalid_model_output_falls_back_and_valid_cache_is_reused_after_rebuild(self):
        file_data = {
            "id": "file-1",
            "user_id": "user-1",
            "project_space_id": "space-1",
            "filename": "reliability.md",
        }
        rule_rows = [{
            "id": "rule-chunk",
            "chunk_index": 0,
            "content": "订单服务依赖 Redis。",
        }]
        fallback = extract_graph_facts(
            file_data,
            rule_rows,
            extraction_provider=lambda _window: {"invalid": []},
        )
        self.assertEqual(fallback["extraction_stats"]["fallbacks"], 1)
        self.assertTrue(any(rel["type"] == "DEPENDS_ON" for rel in fallback["relationships"]))

        single_chunk_payload = {
            "entities": [
                {"name": "Gateway", "type": "Service", "aliases": []},
                {"name": "Worker", "type": "Service", "aliases": []},
            ],
            "mentions": [
                {"entity": "Gateway", "surface": "Gateway", "chunk_id": "target", "evidence_span": "Gateway connects Worker."},
                {"entity": "Worker", "surface": "Worker", "chunk_id": "target", "evidence_span": "Gateway connects Worker."},
            ],
            "relations": [{
                "source": "Gateway",
                "target": "Worker",
                "type": "CONNECTS_TO",
                "evidence": [{"chunk_id": "target", "span": "Gateway connects Worker."}],
            }],
            "coreferences": [],
        }
        first_rows = [{"id": "old-id", "chunk_index": 0, "content": "Gateway connects Worker."}]
        first = extract_graph_facts(file_data, first_rows, extraction_provider=lambda _window: single_chunk_payload)
        record = first["extractions"][0]
        expected_key = extraction_cache_key(
            record["content_hash"],
            graph_extraction.settings.graph_extractor_version,
            graph_extraction.settings.graph_ontology_version,
            record["provider_fingerprint"],
        )
        self.assertEqual(record["cache_key"], expected_key)

        rebuilt_rows = [{"id": "new-id", "chunk_index": 0, "content": "Gateway connects Worker."}]
        second = extract_graph_facts(
            file_data,
            rebuilt_rows,
            cached_extractions={record["cache_key"]: record["payload"]},
            extraction_provider=lambda _window: self.fail("cache should avoid a provider call"),
        )
        self.assertEqual(second["extraction_stats"]["cache_hits"], 1)
        relation = next(
            rel for rel in second["relationships"]
            if rel.get("type") == "CONNECTS_TO"
        )
        self.assertEqual(relation["evidence_chunk_ids"], ["new-id"])
        self.assertEqual(
            set(relation["extractors"]),
            {f"llm_json:{graph_extraction.settings.graph_extractor_version}"},
        )

    def test_cross_chunk_llm_evidence_owns_adjacent_chunk_while_uncovered_failure_falls_back(self):
        file_data = {
            "id": "file-1",
            "user_id": "user-1",
            "project_space_id": "space-1",
            "filename": "dependencies.md",
        }
        rows = [
            {
                "id": "chunk-a",
                "chunk_index": 0,
                "content": "# Reliability\n\nDependency overview.",
            },
            {
                "id": "chunk-b",
                "chunk_index": 1,
                "content": "# Reliability\n\n订单服务依赖 Redis。",
            },
            {
                "id": "chunk-c",
                "chunk_index": 2,
                "content": "# Reliability\n\n支付服务依赖 PostgreSQL。",
            },
        ]
        adjacent_payload = {
            "entities": [
                {"name": "订单服务", "type": "Service", "aliases": []},
                {"name": "Redis", "type": "Database", "aliases": []},
            ],
            "mentions": [
                {
                    "entity": "订单服务",
                    "surface": "订单服务",
                    "chunk_id": "next_1",
                    "evidence_span": "订单服务依赖 Redis。",
                },
                {
                    "entity": "Redis",
                    "surface": "Redis",
                    "chunk_id": "next_1",
                    "evidence_span": "订单服务依赖 Redis。",
                },
            ],
            "relations": [{
                "source": "订单服务",
                "target": "Redis",
                "type": "DEPENDS_ON",
                "evidence": [{"chunk_id": "next_1", "span": "订单服务依赖 Redis。"}],
            }],
            "coreferences": [],
        }

        def provider(window):
            target = next(
                chunk for chunk in window["chunks"]
                if chunk["chunk_id"] == "target"
            )
            if target["source_chunk_id"] == "chunk-a":
                return adjacent_payload
            raise RuntimeError("target extraction failed")

        facts = extract_graph_facts(file_data, rows, extraction_provider=provider)
        typed_relations = [
            relation for relation in facts["relationships"]
            if relation.get("type") == "DEPENDS_ON"
        ]
        adjacent = next(
            relation for relation in typed_relations
            if relation.get("chunk_id") == "chunk-b"
        )
        uncovered = next(
            relation for relation in typed_relations
            if relation.get("chunk_id") == "chunk-c"
        )

        self.assertEqual(adjacent["extraction_lane"], "primary")
        self.assertEqual(adjacent["extractors"], [f"llm_json:{graph_extraction.settings.graph_extractor_version}"])
        self.assertEqual(uncovered["extraction_lane"], "fallback")
        self.assertEqual(uncovered["extractors"], ["regex_rule:regex-v3"])


if __name__ == "__main__":
    unittest.main()

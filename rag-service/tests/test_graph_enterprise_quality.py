import json
import unittest
from pathlib import Path

from graph_store import extract_graph_facts


FIXTURE = Path(__file__).with_name("fixtures") / "graph_enterprise_gold.json"


def relation_key(relation: dict) -> tuple[str, str, str, str, str]:
    return (
        str(relation.get("type") or ""),
        str(relation.get("from") or ""),
        str(relation.get("to") or ""),
        str(relation.get("polarity") or "affirmative"),
        str(relation.get("modality") or "asserted"),
    )


class GraphEnterpriseQualityTests(unittest.TestCase):
    def test_chinese_rules_fallback_gold_precision_and_recall_gate(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
        true_positives = 0
        predicted_count = 0
        gold_count = 0
        entity_true_positives = 0
        predicted_entity_count = 0
        gold_entity_count = 0

        for index, case in enumerate(cases):
            facts = extract_graph_facts(
                {
                    "id": f"gold-file-{index}",
                    "user_id": "gold-user",
                    "project_space_id": "gold-space",
                    "filename": f"{case['id']}.md",
                },
                [{"id": f"gold-chunk-{index}", "chunk_index": 0, "content": case["text"]}],
            )
            predicted_relations = [
                relation for relation in facts["relationships"]
                if relation.get("fact_id")
            ]
            predicted = {relation_key(relation) for relation in predicted_relations}
            gold = {relation_key(relation) for relation in case["relations"]}
            true_positives += len(predicted & gold)
            predicted_count += len(predicted)
            gold_count += len(gold)
            predicted_entities = {str(entity.get("name") or "") for entity in facts["entities"]}
            gold_entities = {
                str(relation[endpoint])
                for relation in case["relations"]
                for endpoint in ("from", "to")
            }
            entity_true_positives += len(predicted_entities & gold_entities)
            predicted_entity_count += len(predicted_entities)
            gold_entity_count += len(gold_entities)

            self.assertTrue(all(relation.get("evidence_refs_json") for relation in predicted_relations))
            self.assertTrue(all(relation.get("fact_id", "").startswith("kgfact_") for relation in predicted_relations))
            self.assertTrue(all(relation.get("validation_status") == "rule_supported" for relation in predicted_relations))

        precision = true_positives / predicted_count if predicted_count else 0.0
        recall = true_positives / gold_count if gold_count else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        entity_precision = entity_true_positives / predicted_entity_count if predicted_entity_count else 0.0
        entity_recall = entity_true_positives / gold_entity_count if gold_entity_count else 0.0
        entity_f1 = (
            2 * entity_precision * entity_recall / (entity_precision + entity_recall)
            if entity_precision + entity_recall else 0.0
        )

        self.assertGreaterEqual(entity_f1, 0.90)
        self.assertGreaterEqual(precision, 0.95)
        self.assertGreaterEqual(recall, 0.85)
        self.assertGreaterEqual(f1, 0.89)


if __name__ == "__main__":
    unittest.main()

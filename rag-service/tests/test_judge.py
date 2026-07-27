import json
import unittest
from unittest.mock import patch

import judge


class JudgeTests(unittest.TestCase):
    def _evaluate_with_response(self, content, documents=None):
        with (
            patch.object(judge.settings, "rag_judge_enabled", True),
            patch.object(judge.settings, "rag_judge_api_key", "test-key"),
            patch.object(
                judge,
                "post_json",
                return_value={"choices": [{"message": {"content": content}}]},
            ),
        ):
            return judge.evaluate_case_with_judge(
                {"question": "What is the policy?"},
                {"actual_answer": "The policy is enabled. [Source 1]"},
                documents or [],
            )

    def test_invalid_or_incomplete_scores_are_not_reported_as_enabled_zeroes(self):
        invalid_responses = [
            "not json",
            json.dumps({"correctness": 0.8, "completeness": 0.7}),
            json.dumps({
                "correctness": 0.8,
                "completeness": "0.7",
                "faithfulness": 0.9,
            }),
        ]

        for content in invalid_responses:
            with self.subTest(content=content):
                result = self._evaluate_with_response(content)
                self.assertFalse(result["enabled"])
                self.assertEqual(result["label"], "disabled")

    def test_judge_receives_every_packed_document_without_content_truncation(self):
        captured = {}
        long_content = "evidence-" + ("x" * 1500) + "-tail"
        documents = [
            {
                "content": long_content if index == 8 else f"evidence {index}",
                "metadata": {"filename": f"source-{index}.md", "chunk_index": index},
            }
            for index in range(9)
        ]

        def fake_post_json(_base_url, _api_key, _path, body, _timeout):
            captured["body"] = body
            return {
                "choices": [{
                    "message": {
                        "content": json.dumps({
                            "correctness": 0.9,
                            "completeness": 0.8,
                            "faithfulness": 1.0,
                            "label": "grounded",
                            "reasoning": "All claims are supported.",
                        })
                    }
                }]
            }

        with (
            patch.object(judge.settings, "rag_judge_enabled", True),
            patch.object(judge.settings, "rag_judge_api_key", "test-key"),
            patch.object(judge, "post_json", side_effect=fake_post_json),
        ):
            result = judge.evaluate_case_with_judge(
                {"question": "What is the policy?"},
                {"actual_answer": "The policy is enabled. [Source 9]"},
                documents,
            )

        payload = json.loads(captured["body"]["messages"][1]["content"])
        self.assertTrue(result["enabled"])
        self.assertEqual(len(payload["sources"]), 9)
        self.assertEqual(payload["sources"][8]["content"], long_content)


if __name__ == "__main__":
    unittest.main()

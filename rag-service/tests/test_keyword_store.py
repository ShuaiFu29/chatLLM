import unittest
from unittest.mock import patch

import keyword_store


class KeywordStoreTests(unittest.TestCase):
    def test_markdown_search_indexes_and_queries_filename_heading_and_content(self):
        calls = []

        def fake_request(method, path, body=None):
            calls.append((method, path, body))
            if path.endswith("/_search"):
                return {"hits": {"hits": []}}
            return {}

        with patch.object(keyword_store.settings, "elasticsearch_enabled", True), patch.object(
            keyword_store, "_request", side_effect=fake_request
        ):
            keyword_store.ensure_keyword_index()
            keyword_store.search_keyword_chunks("故障处理指南.md", "user-1", "space-1")

        mapping = calls[0][2]
        properties = mapping["mappings"]["properties"]
        self.assertEqual(mapping["mappings"]["_meta"]["chatllm_schema_version"], keyword_store.settings.elasticsearch_schema_version)
        self.assertEqual(properties["filename"]["fields"]["cjk"]["analyzer"], "cjk")
        self.assertIn("heading", properties)
        self.assertIn("content.cjk", calls[1][2]["query"]["bool"]["must"][0]["multi_match"]["fields"])
        self.assertIn("filename^4", calls[1][2]["query"]["bool"]["must"][0]["multi_match"]["fields"])

    def test_search_propagates_transport_failure_as_channel_unavailable(self):
        with patch.object(keyword_store.settings, "elasticsearch_enabled", True), patch.object(
            keyword_store, "_request", side_effect=TimeoutError("private endpoint detail")
        ):
            with self.assertRaisesRegex(
                keyword_store.KeywordStoreUnavailableError,
                "Elasticsearch keyword search failed",
            ) as raised:
                keyword_store.search_keyword_chunks("deployment guide", "user-1", "space-1")

        self.assertIsInstance(raised.exception.__cause__, TimeoutError)
        self.assertNotIn("private endpoint detail", str(raised.exception))


if __name__ == "__main__":
    unittest.main()

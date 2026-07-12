import math
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import compatible_api
import embeddings
import ingestion
import vector_store


def embedding_item(index, values):
    return SimpleNamespace(index=index, embedding=values)


class FakeEmbeddingEndpoint:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def create(self, input, model):
        self.calls.append((list(input), model))
        if not self.responses:
            raise AssertionError("Unexpected embedding request")
        return SimpleNamespace(data=self.responses.pop(0))


class FakeEmbeddingClient:
    def __init__(self, responses):
        self.embeddings = FakeEmbeddingEndpoint(responses)


class EmbeddingIntegrityTests(unittest.TestCase):
    def remote_embeddings(self, texts, response_items, dimension=3):
        fake_client = FakeEmbeddingClient([response_items])
        with patch.object(embeddings.settings, "embedding_provider", "compatible"), patch.object(
            embeddings.settings,
            "embedding_dimension",
            dimension,
        ), patch.object(embeddings, "client", fake_client):
            result = embeddings.get_embeddings(texts)
        return result, fake_client

    def test_compatible_client_preserves_provider_indexes(self):
        client = compatible_api.CompatibleEmbeddingClient("key", "https://example.test")
        with patch("compatible_api.post_json", return_value={
            "data": [
                {"index": 1, "embedding": [1.0, 0.0]},
                {"index": 0, "embedding": [0.0, 1.0]},
            ],
        }):
            response = client.embeddings.create(["first", "second"], "model")

        self.assertEqual(
            [(item.index, item.embedding) for item in response.data],
            [(1, [1.0, 0.0]), (0, [0.0, 1.0])],
        )

    def test_compatible_client_routes_malformed_json_shapes_through_integrity_validation(self):
        malformed_payloads = {
            "top-level list": [],
            "null data": {"data": None},
            "non-object row": {"data": ["provider-secret"]},
        }

        for label, payload in malformed_payloads.items():
            with self.subTest(label=label):
                client = compatible_api.CompatibleEmbeddingClient("key", "https://example.test")
                with patch("compatible_api.post_json", return_value=payload), patch.object(
                    embeddings.settings,
                    "embedding_provider",
                    "compatible",
                ), patch.object(embeddings.settings, "embedding_dimension", 3), patch.object(
                    embeddings,
                    "client",
                    client,
                ):
                    with self.assertRaises(embeddings.EmbeddingIntegrityError) as raised:
                        embeddings.get_embeddings(["first"])

                self.assertEqual(raised.exception.code, "EMBEDDING_RESPONSE_INVALID")
                self.assertNotIn("provider-secret", str(raised.exception))

    def test_reordered_provider_rows_are_restored_to_input_order(self):
        vectors, fake_client = self.remote_embeddings(
            ["first", "second"],
            [
                embedding_item(1, [0.0, 1.0, 0.0]),
                embedding_item(0, [1.0, 0.0, 0.0]),
            ],
        )

        self.assertEqual(vectors, [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        self.assertEqual(fake_client.embeddings.calls, [(["first", "second"], embeddings.settings.embedding_model)])

    def test_malformed_provider_rows_fail_with_a_stable_integrity_error(self):
        malformed_responses = {
            "missing row": [embedding_item(0, [1.0, 0.0, 0.0])],
            "missing index": [
                embedding_item(None, [1.0, 0.0, 0.0]),
                embedding_item(1, [0.0, 1.0, 0.0]),
            ],
            "duplicate index": [
                embedding_item(0, [1.0, 0.0, 0.0]),
                embedding_item(0, [0.0, 1.0, 0.0]),
            ],
            "out of range index": [
                embedding_item(0, [1.0, 0.0, 0.0]),
                embedding_item(2, [0.0, 1.0, 0.0]),
            ],
            "string index": [
                embedding_item("0", [1.0, 0.0, 0.0]),
                embedding_item(1, [0.0, 1.0, 0.0]),
            ],
            "boolean index": [
                embedding_item(False, [1.0, 0.0, 0.0]),
                embedding_item(1, [0.0, 1.0, 0.0]),
            ],
            "empty vector": [
                embedding_item(0, []),
                embedding_item(1, [0.0, 1.0, 0.0]),
            ],
            "wrong dimension": [
                embedding_item(0, [1.0, 0.0]),
                embedding_item(1, [0.0, 1.0, 0.0]),
            ],
            "nan": [
                embedding_item(0, [1.0, math.nan, 0.0]),
                embedding_item(1, [0.0, 1.0, 0.0]),
            ],
            "infinity": [
                embedding_item(0, [1.0, math.inf, 0.0]),
                embedding_item(1, [0.0, 1.0, 0.0]),
            ],
            "numeric overflow": [
                embedding_item(0, [1.0, 10**10000, 0.0]),
                embedding_item(1, [0.0, 1.0, 0.0]),
            ],
            "non numeric": [
                embedding_item(0, [1.0, "provider-secret", 0.0]),
                embedding_item(1, [0.0, 1.0, 0.0]),
            ],
        }

        for label, response in malformed_responses.items():
            with self.subTest(label=label):
                with self.assertRaises(Exception) as raised:
                    self.remote_embeddings(["first", "second"], response)
                self.assertEqual(type(raised.exception).__name__, "EmbeddingIntegrityError")
                self.assertEqual(raised.exception.code, "EMBEDDING_RESPONSE_INVALID")
                self.assertNotIn("provider-secret", str(raised.exception))

    def test_single_embedding_uses_the_same_identity_and_dimension_validation(self):
        fake_client = FakeEmbeddingClient([[embedding_item(1, [1.0, 0.0, 0.0])]])
        with patch.object(embeddings.settings, "embedding_provider", "compatible"), patch.object(
            embeddings.settings,
            "embedding_dimension",
            3,
        ), patch.object(embeddings, "client", fake_client), self.assertRaises(Exception) as raised:
            embeddings.get_embedding("first")

        self.assertEqual(type(raised.exception).__name__, "EmbeddingIntegrityError")

    def test_ingestion_does_not_insert_vectors_when_embedding_count_is_short(self):
        rows = [
            {"id": "chunk-1", "file_id": "file-1", "user_id": "user-1", "chunk_index": 0, "content": "a"},
            {"id": "chunk-2", "file_id": "file-1", "user_id": "user-1", "chunk_index": 1, "content": "b"},
        ]
        file_data = {"filename": "notes.md", "file_type": "text/markdown"}
        with patch("ingestion.index_chunks"), patch("ingestion.index_graph_chunks"), patch(
            "ingestion.get_embeddings",
            return_value=[[1.0, 0.0, 0.0]],
        ), patch("ingestion.insert_vectors") as insert_vectors:
            with self.assertRaises(Exception) as raised:
                ingestion.index_chunk_batch(file_data, rows, "space-1")

        self.assertEqual(type(raised.exception).__name__, "EmbeddingIntegrityError")
        insert_vectors.assert_not_called()

    def test_ingestion_rejects_insert_count_mismatch_and_reports_committed_count(self):
        rows = [
            {"id": "chunk-1", "file_id": "file-1", "user_id": "user-1", "chunk_index": 0, "content": "a"},
            {"id": "chunk-2", "file_id": "file-1", "user_id": "user-1", "chunk_index": 1, "content": "b"},
        ]
        file_data = {"filename": "notes.md", "file_type": "text/markdown"}
        vectors = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]

        with patch("ingestion.index_chunks"), patch("ingestion.index_graph_chunks"), patch(
            "ingestion.get_embeddings",
            return_value=vectors,
        ), patch("ingestion.insert_vectors", return_value=1):
            with self.assertRaises(Exception) as raised:
                ingestion.index_chunk_batch(file_data, rows, "space-1")
        self.assertEqual(type(raised.exception).__name__, "EmbeddingIntegrityError")

        with patch("ingestion.index_chunks"), patch("ingestion.index_graph_chunks"), patch(
            "ingestion.get_embeddings",
            return_value=vectors,
        ), patch("ingestion.insert_vectors", return_value=2):
            stats = ingestion.index_chunk_batch(file_data, rows, "space-1")
        self.assertEqual(stats["indexed_chunks"], 2)

    def test_vector_store_returns_and_validates_milvus_insert_counts(self):
        class FakeMilvusClient:
            def __init__(self, counts):
                self.counts = list(counts)
                self.calls = []

            def insert(self, collection_name, data):
                self.calls.append((collection_name, list(data)))
                return {"insert_count": self.counts.pop(0)}

        rows = [
            {"chunk_id": "chunk-1", "project_space_id": "space-1"},
            {"chunk_id": "chunk-2", "project_space_id": "space-1"},
        ]
        client = FakeMilvusClient([1, 1])
        with patch("vector_store.get_client", return_value=client), patch(
            "vector_store.ensure_collection",
        ), patch("vector_store._has_project_space_field", return_value=True), patch.object(
            vector_store.settings,
            "milvus_insert_batch_size",
            1,
        ):
            self.assertEqual(vector_store.insert_vectors(rows), 2)

        partial_client = FakeMilvusClient([0])
        with patch("vector_store.get_client", return_value=partial_client), patch(
            "vector_store.ensure_collection",
        ), patch("vector_store._has_project_space_field", return_value=True), patch.object(
            vector_store.settings,
            "milvus_insert_batch_size",
            2,
        ), self.assertRaises(RuntimeError):
            vector_store.insert_vectors(rows)


if __name__ == "__main__":
    unittest.main()

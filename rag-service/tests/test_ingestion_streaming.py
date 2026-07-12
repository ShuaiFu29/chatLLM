import unittest
from unittest.mock import DEFAULT, patch

import ingestion


ATTEMPT_ID = "11111111-1111-4111-8111-111111111111"
LEASE_TOKEN = "22222222-2222-4222-8222-222222222222"


class StreamingIngestionTests(unittest.TestCase):
    def setUp(self):
        self.job_tracking_patch = patch.multiple(
            "ingestion",
            start_ingestion_job=DEFAULT,
            update_ingestion_job_checkpoint=DEFAULT,
            complete_ingestion_job=DEFAULT,
            fail_ingestion_job=DEFAULT,
            assert_ingestion_lease=DEFAULT,
        )
        self.job_tracking_patch.start()

    def tearDown(self):
        self.job_tracking_patch.stop()

    def test_streaming_markdown_chunker_yields_bounded_chunks(self):
        payload = [
            b"# Heading\n\n",
            ("A" * 1200).encode("utf-8"),
            b"\n\n## Next\n\n",
            ("B" * 900).encode("utf-8"),
        ]

        chunks = list(ingestion.iter_streaming_markdown_chunks(
            payload,
            chunk_size=500,
            chunk_overlap=50,
        ))

        self.assertGreaterEqual(len(chunks), 4)
        self.assertTrue(all(chunk.strip() for chunk in chunks))
        self.assertTrue(all(len(chunk) <= 650 for chunk in chunks))
        self.assertIn("# Heading", chunks[0])

    def test_large_file_ingestion_streams_and_indexes_in_batches(self):
        original_threshold = ingestion.settings.rag_ingest_streaming_threshold_bytes
        original_chunk_batch_size = ingestion.settings.rag_ingest_chunk_batch_size
        original_embedding_batch_size = ingestion.settings.rag_ingest_embedding_batch_size
        ingestion.settings.rag_ingest_streaming_threshold_bytes = 1
        ingestion.settings.rag_ingest_chunk_batch_size = 2
        ingestion.settings.rag_ingest_embedding_batch_size = 2

        inserted_batches = []
        keyword_batches = []
        graph_batches = []
        vector_batches = []

        def fake_insert_batch(file_id, user_id, start_index, chunks, file_data):
            inserted_batches.append(list(chunks))
            return [
                {
                    "id": f"chunk-{start_index + offset}",
                    "file_id": file_id,
                    "user_id": user_id,
                    "chunk_index": start_index + offset,
                    "content": chunk,
                    "metadata": {
                        "filename": file_data["filename"],
                        "project_space_id": file_data.get("project_space_id"),
                        "chunk_index": start_index + offset,
                    },
                }
                for offset, chunk in enumerate(chunks)
            ]

        def fake_embeddings(chunks):
            self.assertLessEqual(len(chunks), 2)
            return [[0.1, 0.2] for _ in chunks]

        stream_payload = [
            b"# Title\n\n",
            ("Alpha " * 220).encode("utf-8"),
            b"\n\n## Detail\n\n",
            ("Beta " * 220).encode("utf-8"),
        ]

        with patch("ingestion.get_file", return_value={
            "id": "file-1",
            "user_id": "user-1",
            "filename": "large.md",
            "file_type": "text/markdown",
            "object_key": "uploads/large.md",
            "file_hash": "",
            "file_size": sum(len(part) for part in stream_payload),
            "project_space_id": "space-1",
        }), patch("ingestion.download_object") as download_object_mock, patch(
            "ingestion.stream_object_bytes",
            return_value=iter(stream_payload),
        ), patch("ingestion.delete_file_vectors"), patch("ingestion.delete_file_keywords"), patch(
            "ingestion.delete_file_graph"
        ), patch("ingestion.delete_file_chunks"), patch(
            "ingestion.insert_file_chunk_batch", side_effect=fake_insert_batch
        ), patch("ingestion.index_chunks", side_effect=lambda rows: keyword_batches.append(list(rows))), patch(
            "ingestion.index_graph_chunks", side_effect=lambda _file, rows: graph_batches.append(list(rows))
        ), patch("ingestion.get_embeddings", side_effect=fake_embeddings), patch(
            "ingestion.insert_vectors", side_effect=lambda rows: vector_batches.append(list(rows))
        ), patch("ingestion.bump_project_knowledge_version"), patch(
            "ingestion.complete_ingestion_job"
        ) as complete_job:
            try:
                result = ingestion.process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)
            finally:
                ingestion.settings.rag_ingest_streaming_threshold_bytes = original_threshold
                ingestion.settings.rag_ingest_chunk_batch_size = original_chunk_batch_size
                ingestion.settings.rag_ingest_embedding_batch_size = original_embedding_batch_size

        self.assertEqual(result["status"], "success")
        self.assertGreater(result["chunks"], 2)
        download_object_mock.assert_not_called()
        self.assertGreater(len(inserted_batches), 1)
        self.assertEqual(len(keyword_batches), len(inserted_batches))
        self.assertEqual(len(graph_batches), len(inserted_batches))
        self.assertTrue(all(len(batch) <= 2 for batch in inserted_batches))
        self.assertTrue(all(len(batch) <= 2 for batch in vector_batches))
        complete_job.assert_called_once()

    def test_streaming_ingestion_records_durable_stage_checkpoints(self):
        original_threshold = ingestion.settings.rag_ingest_streaming_threshold_bytes
        original_chunk_batch_size = ingestion.settings.rag_ingest_chunk_batch_size
        ingestion.settings.rag_ingest_streaming_threshold_bytes = 1
        ingestion.settings.rag_ingest_chunk_batch_size = 1

        def fake_insert_batch(file_id, user_id, start_index, chunks, file_data):
            return [
                {
                    "id": f"chunk-{start_index + offset}",
                    "file_id": file_id,
                    "user_id": user_id,
                    "chunk_index": start_index + offset,
                    "content": chunk,
                    "metadata": {"filename": file_data["filename"]},
                }
                for offset, chunk in enumerate(chunks)
            ]

        stream_payload = [
            b"# Title\n\n",
            ("Alpha " * 220).encode("utf-8"),
            b"\n\n",
            ("Beta " * 220).encode("utf-8"),
        ]

        with patch("ingestion.get_file", return_value={
            "id": "file-1",
            "user_id": "user-1",
            "filename": "large.md",
            "file_type": "text/markdown",
            "object_key": "uploads/large.md",
            "file_hash": "",
            "file_size": sum(len(part) for part in stream_payload),
            "project_space_id": "space-1",
        }), patch("ingestion.stream_object_bytes", return_value=iter(stream_payload)), patch(
            "ingestion.delete_file_vectors"
        ), patch("ingestion.delete_file_keywords"), patch("ingestion.delete_file_graph"), patch(
            "ingestion.delete_file_chunks"
        ), patch("ingestion.insert_file_chunk_batch", side_effect=fake_insert_batch), patch(
            "ingestion.index_chunks"
        ), patch("ingestion.index_graph_chunks"), patch("ingestion.get_embeddings", return_value=[[0.1, 0.2]]), patch(
            "ingestion.insert_vectors"
        ), patch("ingestion.bump_project_knowledge_version"), patch(
            "ingestion.start_ingestion_job"
        ) as start_job, patch(
            "ingestion.update_ingestion_job_checkpoint"
        ) as update_checkpoint, patch("ingestion.complete_ingestion_job") as complete_job, patch(
            "ingestion.fail_ingestion_job"
        ) as fail_job:
            try:
                result = ingestion.process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)
            finally:
                ingestion.settings.rag_ingest_streaming_threshold_bytes = original_threshold
                ingestion.settings.rag_ingest_chunk_batch_size = original_chunk_batch_size

        self.assertEqual(result["status"], "success")
        start_job.assert_called_once()
        fail_job.assert_not_called()
        complete_job.assert_called_once()
        stages = [call.kwargs["stage"] for call in update_checkpoint.call_args_list]
        self.assertIn("streaming_download", stages)
        self.assertIn("indexing_vectors", stages)
        self.assertIn("completed", complete_job.call_args.kwargs["stage"])
        final_checkpoint = complete_job.call_args.kwargs["checkpoint"]
        self.assertGreater(final_checkpoint["indexed_chunks"], 0)
        self.assertEqual(final_checkpoint["mode"], "streaming")


if __name__ == "__main__":
    unittest.main()

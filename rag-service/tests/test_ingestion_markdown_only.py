import unittest
from unittest.mock import DEFAULT, patch

from db import _build_chunk_metadata, list_parent_chunks_for_matches
from ingestion import (
    extract_text,
    format_ingestion_error,
    iter_streaming_markdown_chunks,
    process_file,
    split_text,
)
from parent_context import build_parent_section_documents


ATTEMPT_ID = "11111111-1111-4111-8111-111111111111"
LEASE_TOKEN = "22222222-2222-4222-8222-222222222222"


class MarkdownOnlyIngestionTests(unittest.TestCase):
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

    def test_markdown_chunks_keep_heading_context(self):
        chunks = split_text(
            "# Authentication\n\nOverview.\n\n## Token rotation\n\nRotate refresh tokens after use.",
            True,
        )

        token_chunk = next(chunk for chunk in chunks if "Rotate refresh tokens" in chunk)
        self.assertIn("## Token rotation", token_chunk)

    def test_long_markdown_section_repeats_full_heading_path_on_every_chunk(self):
        chunks = split_text(
            "# Authentication\n\n## Token rotation\n\n" + ("rotation policy detail " * 180),
            True,
        )

        self.assertGreater(len(chunks), 2)
        self.assertTrue(all(chunk.startswith("# Authentication\n## Token rotation") for chunk in chunks))

    def test_same_subheading_under_different_parents_keeps_distinct_context(self):
        chunks = split_text(
            "# Service A\n\n## Configuration\n\nUses port 7001.\n\n"
            "# Service B\n\n## Configuration\n\nUses port 7002.",
            True,
        )

        service_a = next(chunk for chunk in chunks if "7001" in chunk)
        service_b = next(chunk for chunk in chunks if "7002" in chunk)
        self.assertTrue(service_a.startswith("# Service A\n## Configuration"))
        self.assertTrue(service_b.startswith("# Service B\n## Configuration"))

        metadata_a = _build_chunk_metadata("file-1", "user-1", 0, {"filename": "notes.md"}, service_a)
        metadata_b = _build_chunk_metadata("file-1", "user-1", 1, {"filename": "notes.md"}, service_b)
        self.assertNotEqual(metadata_a["parent_section_id"], metadata_b["parent_section_id"])

    def test_parent_section_expansion_merges_children_without_repeating_heading_path(self):
        parent_id = "parent-auth"
        children = [{
            "id": "chunk-2",
            "content": "# Authentication\n## Rotation\n\nSecond detail.",
            "metadata": {
                "file_id": "file-1",
                "filename": "auth.md",
                "chunk_index": 2,
                "parent_section_id": parent_id,
                "heading_path": ["Authentication", "Rotation"],
            },
            "retrieval_channels": ["vector", "bm25"],
            "retrieval_score": 1.0,
        }]
        rows = [
            {
                "id": "chunk-1",
                "file_id": "file-1",
                "chunk_index": 1,
                "content": "# Authentication\n## Rotation\n\nFirst detail.",
                "metadata": {"file_id": "file-1", "parent_section_id": parent_id},
            },
            {
                "id": "chunk-2",
                "file_id": "file-1",
                "chunk_index": 2,
                "content": "# Authentication\n## Rotation\n\nSecond detail.",
                "metadata": {"file_id": "file-1", "parent_section_id": parent_id},
            },
        ]

        expanded = build_parent_section_documents(children, rows)

        self.assertEqual(len(expanded), 1)
        self.assertEqual(expanded[0]["metadata"]["matched_child_ids"], ["chunk-2"])
        self.assertEqual(expanded[0]["metadata"]["parent_chunk_count"], 2)
        self.assertEqual(expanded[0]["content"].count("# Authentication"), 1)
        self.assertIn("First detail", expanded[0]["content"])
        self.assertIn("Second detail", expanded[0]["content"])

    def test_parent_section_loading_centers_window_on_ranked_child(self):
        with patch("db.get_conn") as get_conn:
            cursor = get_conn.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
            cursor.fetchall.return_value = []

            list_parent_chunks_for_matches(
                "user-1",
                "space-1",
                [{
                    "id": "child-47",
                    "metadata": {
                        "file_id": "11111111-1111-4111-8111-111111111111",
                        "parent_section_id": "long-root-section",
                        "chunk_index": 47,
                    },
                }],
                max_parents=3,
                max_chunks_per_parent=6,
            )

        statement, params = cursor.execute.call_args.args
        self.assertIn("abs(file_chunks.chunk_index - requested.matched_chunk_index)", statement)
        self.assertEqual(params[2], [47])
        self.assertEqual(params[-1], 6)

    def test_streaming_markdown_chunks_keep_heading_path(self):
        markdown = (
            "# Operations\n\n## Recovery\n\n" + ("restore from checkpoint " * 100)
        ).encode("utf-8")
        chunks = list(iter_streaming_markdown_chunks(
            [markdown[:17], markdown[17:83], markdown[83:]],
            chunk_size=240,
            chunk_overlap=30,
        ))

        self.assertGreater(len(chunks), 2)
        self.assertTrue(all(chunk.startswith("# Operations\n## Recovery") for chunk in chunks))

    def test_extract_text_accepts_markdown_extensions(self):
        text, is_markdown = extract_text(b"# Title\n\nBody", "text/markdown", "notes.markdown")

        self.assertEqual(text, "# Title\n\nBody")
        self.assertTrue(is_markdown)

    def test_extract_text_rejects_pdf_documents(self):
        with self.assertRaisesRegex(ValueError, "Only Markdown"):
            extract_text(b"%PDF-1.4", "application/pdf", "paper.pdf")

    def test_process_file_rejects_non_markdown_before_streaming_path(self):
        with patch("ingestion.get_file", return_value={
            "id": "file-1",
            "user_id": "user-1",
            "filename": "paper.pdf",
            "file_type": "application/pdf",
            "object_key": "uploads/paper.pdf",
            "project_space_id": None,
        }), patch("ingestion.should_stream_ingestion", return_value=True), patch(
            "ingestion.process_streaming_file"
        ) as streaming_process:
            with self.assertRaisesRegex(ValueError, "Only Markdown"):
                process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        streaming_process.assert_not_called()

    def test_ingestion_errors_allowlist_user_actions_without_exposing_unknown_details(self):
        self.assertEqual(
            format_ingestion_error(RuntimeError("provider injected-secret-value")),
            "Document ingestion failed",
        )
        self.assertEqual(
            format_ingestion_error(RuntimeError("batch size is invalid: 999")),
            "Embedding 批量大小超过服务限制，请稍后重试。",
        )

    def test_process_file_limits_embedding_batches_to_provider_safe_size(self):
        chunks = [f"chunk {index}" for index in range(12)]
        chunk_rows = [
            {
                "id": f"chunk-{index}",
                "file_id": "file-1",
                "user_id": "user-1",
                "chunk_index": index,
                "content": content,
            }
            for index, content in enumerate(chunks)
        ]
        embedding_calls = []

        def fake_get_embeddings(batch):
            embedding_calls.append(list(batch))
            return [[0.1, 0.2] for _ in batch]

        with patch("ingestion.get_file", return_value={
            "id": "file-1",
            "user_id": "user-1",
            "filename": "notes.md",
            "file_type": "text/markdown",
            "object_key": "uploads/notes.md",
            "project_space_id": None,
        }), patch("ingestion.download_object", return_value=b"# Notes"), patch(
            "ingestion.extract_text", return_value=("# Notes", True)
        ), patch("ingestion.split_text", return_value=chunks), patch(
            "ingestion.delete_file_vectors"
        ), patch("ingestion.delete_file_keywords"
        ), patch("ingestion.delete_file_graph"
        ), patch("ingestion.replace_file_chunks", return_value=chunk_rows), patch(
            "ingestion.get_embeddings", side_effect=fake_get_embeddings
        ), patch("ingestion.insert_vectors", side_effect=lambda rows: len(rows)), patch(
            "ingestion.index_chunks"
        ), patch("ingestion.index_graph_chunks"):
            result = process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        self.assertEqual(result, {"status": "success", "chunks": 12})
        self.assertEqual([len(batch) for batch in embedding_calls], [10, 2])
        self.assertTrue(all(text.startswith("notes.md\n") for batch in embedding_calls for text in batch))

    def test_process_file_stores_friendly_message_for_bailian_quota_errors(self):
        with patch("ingestion.get_file", return_value={
            "id": "file-1",
            "user_id": "user-1",
            "filename": "notes.md",
            "file_type": "text/markdown",
            "object_key": "uploads/notes.md",
            "project_space_id": None,
        }), patch("ingestion.download_object", return_value=b"# Notes"), patch(
            "ingestion.extract_text", return_value=("# Notes", True)
        ), patch("ingestion.split_text", return_value=["chunk"]), patch(
            "ingestion.delete_file_vectors"
        ), patch("ingestion.delete_file_keywords"
        ), patch("ingestion.delete_file_graph"
        ), patch("ingestion.replace_file_chunks", return_value=[{
            "id": "chunk-1",
            "file_id": "file-1",
            "user_id": "user-1",
            "chunk_index": 0,
            "content": "chunk",
        }]), patch("ingestion.get_embeddings", side_effect=RuntimeError(
            "Error code: 429 - {'error': {'code': '1113', 'message': '余额不足或无可用资源包,请充值。'}}"
        )), patch("ingestion.insert_vectors", side_effect=lambda rows: len(rows)), patch(
            "ingestion.index_chunks"
        ), patch("ingestion.index_graph_chunks"), patch(
            "ingestion.fail_ingestion_job"
        ) as fail_job:
            with self.assertRaises(RuntimeError):
                process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        failed_error = fail_job.call_args.args[3]
        self.assertIn("百炼 embedding 额度不足", failed_error)
        self.assertNotIn("{'error'", failed_error)

    def test_process_file_indexes_chunks_for_bm25_search_before_vector_insert(self):
        chunk_rows = [{
            "id": "chunk-1",
            "file_id": "file-1",
            "user_id": "user-1",
            "chunk_index": 0,
            "content": "JSBridge lets WebView communicate with Native.",
            "metadata": {"filename": "notes.md"},
        }]

        with patch("ingestion.get_file", return_value={
            "id": "file-1",
            "user_id": "user-1",
            "filename": "notes.md",
            "file_type": "text/markdown",
            "object_key": "uploads/notes.md",
            "project_space_id": "space-1",
        }), patch("ingestion.download_object", return_value=b"# Notes"), patch(
            "ingestion.extract_text", return_value=("# Notes", True)
        ), patch("ingestion.split_text", return_value=["chunk"]), patch(
            "ingestion.delete_file_vectors"
        ), patch("ingestion.delete_file_keywords"
        ), patch("ingestion.delete_file_graph"
        ), patch("ingestion.replace_file_chunks", return_value=chunk_rows), patch(
            "ingestion.get_embeddings", return_value=[[0.1, 0.2]]
        ), patch("ingestion.insert_vectors", side_effect=lambda rows: len(rows)), patch(
            "ingestion.index_graph_chunks"
        ), patch(
            "ingestion.index_chunks"
        ) as index_chunks_mock, patch("ingestion.bump_project_knowledge_version"):
            process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        indexed_rows = index_chunks_mock.call_args.args[0]
        self.assertEqual(indexed_rows[0]["id"], "chunk-1")
        self.assertEqual(indexed_rows[0]["metadata"]["filename"], "notes.md")
        self.assertEqual(indexed_rows[0]["metadata"]["project_space_id"], "space-1")

    def test_process_file_rejects_object_when_uploaded_hash_does_not_match_metadata(self):
        with patch("ingestion.get_file", return_value={
            "id": "file-1",
            "user_id": "user-1",
            "filename": "notes.md",
            "file_type": "text/markdown",
            "object_key": "uploads/notes.md",
            "file_hash": "0" * 64,
            "file_size": 7,
            "project_space_id": "space-1",
        }), patch("ingestion.download_object", return_value=b"# Notes"), patch(
            "ingestion.extract_text"
        ) as extract_text_mock, patch("ingestion.fail_ingestion_job") as fail_job:
            with self.assertRaisesRegex(ValueError, "Uploaded object hash mismatch"):
                process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        extract_text_mock.assert_not_called()
        failed_error = fail_job.call_args.args[3]
        self.assertEqual(failed_error, "Uploaded object integrity check failed")
        self.assertNotIn("0" * 64, failed_error)

    def test_process_file_indexes_chunks_into_knowledge_graph(self):
        chunk_rows = [{
            "id": "chunk-1",
            "file_id": "file-1",
            "user_id": "user-1",
            "chunk_index": 0,
            "content": "JSBridge connects WebView and Native.",
            "metadata": {"filename": "notes.md"},
        }]

        with patch("ingestion.get_file", return_value={
            "id": "file-1",
            "user_id": "user-1",
            "filename": "notes.md",
            "file_type": "text/markdown",
            "object_key": "uploads/notes.md",
            "project_space_id": "space-1",
        }) as get_file_mock, patch("ingestion.download_object", return_value=b"# Notes"), patch(
            "ingestion.extract_text", return_value=("# Notes", True)
        ), patch("ingestion.split_text", return_value=["chunk"]), patch(
            "ingestion.delete_file_vectors"
        ), patch("ingestion.delete_file_keywords"), patch(
            "ingestion.delete_file_graph"
        ), patch("ingestion.replace_file_chunks", return_value=chunk_rows), patch(
            "ingestion.get_embeddings", return_value=[[0.1, 0.2]]
        ), patch("ingestion.insert_vectors", side_effect=lambda rows: len(rows)), patch(
            "ingestion.index_chunks"
        ), patch(
            "ingestion.index_graph_chunks"
        ) as index_graph_mock, patch("ingestion.bump_project_knowledge_version"):
            process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        self.assertEqual(index_graph_mock.call_args.args[0], get_file_mock.return_value)
        self.assertEqual(index_graph_mock.call_args.args[1][0]["metadata"]["project_space_id"], "space-1")

    def test_process_file_fails_when_enabled_graph_index_times_out(self):
        chunk_rows = [{
            "id": "chunk-1",
            "file_id": "file-1",
            "user_id": "user-1",
            "chunk_index": 0,
            "content": "T+5 is the default response confirmation window.",
            "metadata": {"filename": "notes.md"},
        }]

        with patch("ingestion.get_file", return_value={
            "id": "file-1",
            "user_id": "user-1",
            "filename": "notes.md",
            "file_type": "text/markdown",
            "object_key": "uploads/notes.md",
            "project_space_id": "space-1",
        }), patch("ingestion.download_object", return_value=b"# Notes"), patch(
            "ingestion.extract_text", return_value=("# Notes", True)
        ), patch("ingestion.split_text", return_value=["chunk"]), patch(
            "ingestion.delete_file_vectors"
        ), patch("ingestion.delete_file_keywords"), patch(
            "ingestion.delete_file_graph"
        ), patch("ingestion.replace_file_chunks", return_value=chunk_rows), patch(
            "ingestion.get_embeddings", return_value=[[0.1, 0.2]]
        ), patch(
            "ingestion.insert_vectors",
            side_effect=lambda rows: len(rows),
        ) as insert_vectors_mock, patch(
            "ingestion.index_chunks"
        ), patch("ingestion.index_graph_chunks", side_effect=TimeoutError("timed out")), patch(
            "ingestion.bump_project_knowledge_version"
        ), patch(
            "ingestion.complete_ingestion_job"
        ) as complete_job:
            with self.assertRaisesRegex(TimeoutError, "timed out"):
                process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        complete_job.assert_not_called()
        insert_vectors_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()

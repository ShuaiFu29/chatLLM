import unittest
from unittest.mock import DEFAULT, patch

from ingestion import extract_text, format_ingestion_error, process_file


class MarkdownOnlyIngestionTests(unittest.TestCase):
    def setUp(self):
        self.job_tracking_patch = patch.multiple(
            "ingestion",
            start_ingestion_job=DEFAULT,
            update_ingestion_job_checkpoint=DEFAULT,
            complete_ingestion_job=DEFAULT,
            fail_ingestion_job=DEFAULT,
        )
        self.job_tracking_patch.start()

    def tearDown(self):
        self.job_tracking_patch.stop()

    def test_extract_text_accepts_markdown_extensions(self):
        text, is_markdown = extract_text(b"# Title\n\nBody", "text/markdown", "notes.markdown")

        self.assertEqual(text, "# Title\n\nBody")
        self.assertTrue(is_markdown)

    def test_extract_text_rejects_pdf_documents(self):
        with self.assertRaisesRegex(ValueError, "Only Markdown"):
            extract_text(b"%PDF-1.4", "application/pdf", "paper.pdf")

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
        ), patch("ingestion.insert_vectors"), patch("ingestion.index_chunks"), patch("ingestion.index_graph_chunks"), patch(
            "ingestion.update_file_status"
        ), patch("ingestion.update_file_progress"):
            result = process_file("file-1")

        self.assertEqual(result, {"status": "success", "chunks": 12})
        self.assertEqual([len(batch) for batch in embedding_calls], [10, 2])

    def test_process_file_stores_friendly_message_for_bailian_quota_errors(self):
        status_updates = []

        def capture_status(file_id, status, progress=None, error_message=None):
            status_updates.append({
                "file_id": file_id,
                "status": status,
                "progress": progress,
                "error_message": error_message,
            })

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
        )), patch("ingestion.insert_vectors"), patch("ingestion.index_chunks"), patch("ingestion.index_graph_chunks"), patch(
            "ingestion.update_file_status", side_effect=capture_status
        ), patch("ingestion.update_file_progress"):
            with self.assertRaises(RuntimeError):
                process_file("file-1")

        failed_update = status_updates[-1]
        self.assertEqual(failed_update["status"], "failed")
        self.assertIn("百炼 embedding 额度不足", failed_update["error_message"])
        self.assertNotIn("{'error'", failed_update["error_message"])

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
        ), patch("ingestion.insert_vectors"), patch("ingestion.index_graph_chunks"), patch(
            "ingestion.index_chunks"
        ) as index_chunks_mock, patch("ingestion.bump_project_knowledge_version"), patch("ingestion.update_file_status"), patch(
            "ingestion.update_file_progress"
        ):
            process_file("file-1")

        indexed_rows = index_chunks_mock.call_args.args[0]
        self.assertEqual(indexed_rows[0]["id"], "chunk-1")
        self.assertEqual(indexed_rows[0]["metadata"]["filename"], "notes.md")
        self.assertEqual(indexed_rows[0]["metadata"]["project_space_id"], "space-1")

    def test_process_file_rejects_object_when_uploaded_hash_does_not_match_metadata(self):
        status_updates = []

        def capture_status(file_id, status, progress=None, error_message=None):
            status_updates.append({
                "file_id": file_id,
                "status": status,
                "progress": progress,
                "error_message": error_message,
            })

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
        ) as extract_text_mock, patch("ingestion.update_file_status", side_effect=capture_status):
            with self.assertRaisesRegex(ValueError, "Uploaded object hash mismatch"):
                process_file("file-1")

        extract_text_mock.assert_not_called()
        self.assertEqual(status_updates[-1]["status"], "failed")
        self.assertEqual(status_updates[-1]["error_message"], "Uploaded object integrity check failed")
        self.assertNotIn("0" * 64, status_updates[-1]["error_message"])

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
        ), patch("ingestion.insert_vectors"), patch("ingestion.index_chunks"), patch(
            "ingestion.index_graph_chunks"
        ) as index_graph_mock, patch("ingestion.bump_project_knowledge_version"), patch("ingestion.update_file_status"), patch(
            "ingestion.update_file_progress"
        ):
            process_file("file-1")

        self.assertEqual(index_graph_mock.call_args.args[0], get_file_mock.return_value)
        self.assertEqual(index_graph_mock.call_args.args[1][0]["metadata"]["project_space_id"], "space-1")

    def test_process_file_keeps_core_ingestion_when_graph_index_times_out(self):
        status_updates = []
        chunk_rows = [{
            "id": "chunk-1",
            "file_id": "file-1",
            "user_id": "user-1",
            "chunk_index": 0,
            "content": "T+5 is the default response confirmation window.",
            "metadata": {"filename": "notes.md"},
        }]

        def capture_status(file_id, status, progress=None, error_message=None):
            status_updates.append({
                "file_id": file_id,
                "status": status,
                "progress": progress,
                "error_message": error_message,
            })

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
        ), patch("ingestion.insert_vectors") as insert_vectors_mock, patch(
            "ingestion.index_chunks"
        ), patch("ingestion.index_graph_chunks", side_effect=TimeoutError("timed out")), patch(
            "ingestion.logger.warning"
        ) as warning_mock, patch("ingestion.bump_project_knowledge_version"), patch(
            "ingestion.update_file_status", side_effect=capture_status
        ), patch("ingestion.update_file_progress"):
            result = process_file("file-1")

        self.assertEqual(result, {"status": "success", "chunks": 1})
        self.assertEqual(status_updates[-1]["status"], "completed")
        insert_vectors_mock.assert_called_once()
        warning_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()

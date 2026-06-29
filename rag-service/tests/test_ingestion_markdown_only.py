import unittest
from unittest.mock import patch

from ingestion import extract_text, process_file


class MarkdownOnlyIngestionTests(unittest.TestCase):
    def test_extract_text_accepts_markdown_extensions(self):
        text, is_markdown = extract_text(b"# Title\n\nBody", "text/markdown", "notes.markdown")

        self.assertEqual(text, "# Title\n\nBody")
        self.assertTrue(is_markdown)

    def test_extract_text_rejects_pdf_documents(self):
        with self.assertRaisesRegex(ValueError, "Only Markdown"):
            extract_text(b"%PDF-1.4", "application/pdf", "paper.pdf")

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
        ), patch("ingestion.replace_file_chunks", return_value=chunk_rows), patch(
            "ingestion.get_embeddings", side_effect=fake_get_embeddings
        ), patch("ingestion.insert_vectors"), patch(
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
        ), patch("ingestion.replace_file_chunks", return_value=[{
            "id": "chunk-1",
            "file_id": "file-1",
            "user_id": "user-1",
            "chunk_index": 0,
            "content": "chunk",
        }]), patch("ingestion.get_embeddings", side_effect=RuntimeError(
            "Error code: 429 - {'error': {'code': '1113', 'message': '余额不足或无可用资源包,请充值。'}}"
        )), patch("ingestion.insert_vectors"), patch(
            "ingestion.update_file_status", side_effect=capture_status
        ), patch("ingestion.update_file_progress"):
            with self.assertRaises(RuntimeError):
                process_file("file-1")

        failed_update = status_updates[-1]
        self.assertEqual(failed_update["status"], "failed")
        self.assertIn("百炼 embedding 额度不足", failed_update["error_message"])
        self.assertNotIn("{'error'", failed_update["error_message"])


if __name__ == "__main__":
    unittest.main()

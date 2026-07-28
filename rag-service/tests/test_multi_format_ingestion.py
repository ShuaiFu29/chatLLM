import hashlib
import json
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

import db
import ingestion
from converted_document import DocumentConversionError
from converted_ingestion import ConvertedChunk
from storage import DerivedUploadResult, ObjectIntegrity

ATTEMPT_ID = "11111111-1111-4111-8111-111111111111"
LEASE_TOKEN = "22222222-2222-4222-8222-222222222222"


class _GraphTransaction:
    committed_batches = 1
    status = "indexed"

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False


def _download_bytes(payload: bytes):
    integrity = ObjectIntegrity(hashlib.sha256(payload).hexdigest(), len(payload))

    def download(_key, destination, **_kwargs):
        Path(destination).write_bytes(payload)
        return integrity

    return integrity, download


def _upload_local_artifacts(artifacts, *, user_id, file_id, generation_id):
    results = {}
    for role, artifact_path in artifacts.items():
        payload = Path(artifact_path).read_bytes()
        integrity = ObjectIntegrity(hashlib.sha256(payload).hexdigest(), len(payload))
        key = f"users/{user_id}/files/{file_id}/derived/{generation_id}/{role}"
        results[role] = DerivedUploadResult(key, integrity, True)
    return results


class MultiFormatIngestionTests(unittest.TestCase):
    def test_markdown_uses_conversion_generation_and_marker_free_provenance_chunks(self):
        payload = "# 标题\n\n第一段。\n\n第二段。".encode()
        integrity, download = _download_bytes(payload)
        file_data = {
            "id": "file-1",
            "user_id": "user-1",
            "project_space_id": "space-1",
            "filename": "知识.md",
            "file_hash": integrity.sha256,
            "file_size": integrity.byte_size,
            "file_type": "text/markdown",
            "document_kind": "markdown",
            "conversion_profile": "markdown-v1",
            "object_key": "users/user-1/files/file-1/raw/original.md",
        }
        captured_chunks = []

        def replace_chunks(file_id, user_id, chunks, indexed_file_data):
            captured_chunks.extend(chunks)
            self.assertEqual(indexed_file_data["conversion_generation_id"], ATTEMPT_ID)
            return [
                {
                    "id": f"chunk-{index}",
                    "file_id": file_id,
                    "user_id": user_id,
                    "chunk_index": index,
                    "content": chunk.content,
                    "metadata": {
                        "filename": indexed_file_data["filename"],
                        "source_locator": chunk.source_locator,
                    },
                }
                for index, chunk in enumerate(chunks)
            ]

        def index_batch(_file_data, rows, _project_space_id, _transaction):
            self.assertTrue(all("<!-- source-unit:" not in row["content"] for row in rows))
            return {
                "indexed_chunks": len(rows),
                "keyword_batches": 1,
                "graph_batches": 0,
                "graph_status": "pending",
                "vector_batches": 1,
            }

        with patch("ingestion.get_file", return_value=file_data), patch(
            "ingestion.assert_ingestion_lease"
        ), patch("ingestion.start_ingestion_job"), patch(
            "ingestion.update_ingestion_job_checkpoint"
        ), patch(
            "ingestion.download_object_to_file", side_effect=download
        ), patch(
            "ingestion.create_or_reuse_conversion_generation"
        ) as create_generation, patch(
            "ingestion.upload_derived_artifacts", side_effect=_upload_local_artifacts
        ), patch(
            "ingestion.complete_conversion_generation"
        ) as complete_generation, patch(
            "ingestion.reset_file_indexes"
        ), patch(
            "ingestion.replace_file_chunks", side_effect=replace_chunks
        ), patch(
            "ingestion.graph_file_transaction", return_value=_GraphTransaction()
        ), patch(
            "ingestion.index_chunk_batch", side_effect=index_batch
        ), patch(
            "ingestion.activate_conversion_generation_and_complete_ingestion_job",
            return_value={"conversion_generation_id": ATTEMPT_ID},
        ) as activate_generation, patch(
            "ingestion.bump_project_knowledge_version"
        ) as legacy_bump, patch("ingestion.fail_ingestion_job") as fail_job:
            result = ingestion.process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        self.assertEqual(
            result,
            {
                "status": "success",
                "chunks": len(captured_chunks),
                "conversion_generation_id": ATTEMPT_ID,
            },
        )
        self.assertGreater(len(captured_chunks), 0)
        self.assertTrue(all(chunk.source_unit_ids for chunk in captured_chunks))
        self.assertTrue(all(chunk.source_locator["type"] == "markdown" for chunk in captured_chunks))
        create_generation.assert_called_once()
        complete_generation.assert_called_once()
        activate_generation.assert_called_once()
        legacy_bump.assert_not_called()
        fail_job.assert_not_called()

    def test_conversion_failure_is_safe_and_preserves_existing_indexes(self):
        payload = b"not-a-pdf"
        integrity, download = _download_bytes(payload)
        file_data = {
            "id": "file-1",
            "user_id": "user-1",
            "filename": "paper.pdf",
            "file_hash": integrity.sha256,
            "file_size": integrity.byte_size,
            "file_type": "application/pdf",
            "document_kind": "pdf",
            "conversion_profile": "pdf-text-v1",
            "object_key": "users/user-1/files/file-1/raw/original.pdf",
            "project_space_id": None,
        }

        with patch("ingestion.get_file", return_value=file_data), patch(
            "ingestion.assert_ingestion_lease"
        ), patch("ingestion.start_ingestion_job"), patch(
            "ingestion.update_ingestion_job_checkpoint"
        ), patch(
            "ingestion.download_object_to_file", side_effect=download
        ), patch(
            "ingestion.create_or_reuse_conversion_generation"
        ), patch(
            "ingestion.fail_conversion_generation"
        ) as fail_generation, patch(
            "ingestion.upload_derived_artifacts"
        ) as upload_artifacts, patch(
            "ingestion.reset_file_indexes"
        ) as reset_indexes, patch(
            "ingestion.fail_ingestion_job"
        ) as fail_job, self.assertRaises(DocumentConversionError) as context:
            ingestion.process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        self.assertEqual(context.exception.code, "PDF_INVALID_SIGNATURE")
        fail_generation.assert_called_once_with(
            "file-1",
            ATTEMPT_ID,
            ATTEMPT_ID,
            LEASE_TOKEN,
            "PDF_INVALID_SIGNATURE",
        )
        self.assertEqual(fail_job.call_args.args[3], "Document conversion failed")
        upload_artifacts.assert_not_called()
        reset_indexes.assert_not_called()

    def test_uncertain_generation_completion_never_deletes_published_artifacts(self):
        payload = "# 标题\n\n正文".encode()
        integrity, download = _download_bytes(payload)
        file_data = {
            "id": "file-1",
            "user_id": "user-1",
            "filename": "知识.md",
            "file_hash": integrity.sha256,
            "file_size": integrity.byte_size,
            "file_type": "text/markdown",
            "document_kind": "markdown",
            "conversion_profile": "markdown-v1",
            "object_key": "users/user-1/files/file-1/raw/original.md",
            "project_space_id": None,
        }

        with patch("ingestion.get_file", return_value=file_data), patch(
            "ingestion.assert_ingestion_lease"
        ), patch("ingestion.start_ingestion_job"), patch(
            "ingestion.update_ingestion_job_checkpoint"
        ), patch(
            "ingestion.download_object_to_file", side_effect=download
        ), patch(
            "ingestion.create_or_reuse_conversion_generation"
        ), patch(
            "ingestion.upload_derived_artifacts", side_effect=_upload_local_artifacts
        ), patch(
            "ingestion.complete_conversion_generation",
            side_effect=ingestion.IngestionLeaseLostError("completion result is unknown"),
        ), patch(
            "ingestion.cleanup_object_keys"
        ) as cleanup_artifacts, patch(
            "ingestion.fail_conversion_generation",
            side_effect=ingestion.IngestionLeaseLostError("generation may already be completed"),
        ), patch(
            "ingestion.fail_ingestion_job"
        ) as fail_job, self.assertRaises(ingestion.IngestionLeaseLostError):
            ingestion.process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        cleanup_artifacts.assert_not_called()
        fail_job.assert_not_called()

    def test_partial_index_reset_enters_compensation_cleanup(self):
        payload = "# 标题\n\n正文".encode()
        integrity, download = _download_bytes(payload)
        file_data = {
            "id": "file-1",
            "user_id": "user-1",
            "filename": "知识.md",
            "file_hash": integrity.sha256,
            "file_size": integrity.byte_size,
            "file_type": "text/markdown",
            "document_kind": "markdown",
            "conversion_profile": "markdown-v1",
            "object_key": "users/user-1/files/file-1/raw/original.md",
            "project_space_id": None,
        }
        reset_calls = 0

        def reset_indexes(_file_id):
            nonlocal reset_calls
            reset_calls += 1
            if reset_calls == 1:
                raise RuntimeError("keyword reset failed after vector deletion")

        with patch("ingestion.get_file", return_value=file_data), patch(
            "ingestion.assert_ingestion_lease"
        ), patch("ingestion.start_ingestion_job"), patch(
            "ingestion.update_ingestion_job_checkpoint"
        ), patch(
            "ingestion.download_object_to_file", side_effect=download
        ), patch(
            "ingestion.create_or_reuse_conversion_generation"
        ), patch(
            "ingestion.upload_derived_artifacts", side_effect=_upload_local_artifacts
        ), patch(
            "ingestion.complete_conversion_generation"
        ), patch(
            "ingestion.reset_file_indexes", side_effect=reset_indexes
        ), patch(
            "ingestion.delete_file_chunks"
        ) as delete_chunks, patch(
            "ingestion.fail_ingestion_job"
        ) as fail_job, self.assertRaisesRegex(RuntimeError, "keyword reset failed"):
            ingestion.process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        self.assertEqual(reset_calls, 2)
        delete_chunks.assert_called_once_with("file-1")
        fail_job.assert_called_once()

    def test_chunk_persistence_writes_generation_and_source_columns(self):
        chunk = ConvertedChunk(
            content="# 标题\n\n正文",
            source_unit_ids=("u_0123456789abcdef0123456789abcdef",),
            source_locator={"type": "pdf", "page_start": 2, "page_end": 2},
        )
        cursor = MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.return_value = {"id": "chunk-1"}
        connection = MagicMock()
        connection.cursor.return_value = cursor

        @contextmanager
        def fake_connection():
            yield connection

        with patch.object(db, "get_conn", fake_connection):
            rows = db.replace_file_chunks(
                "file-1",
                "user-1",
                [chunk],
                {
                    "filename": "paper.pdf",
                    "document_kind": "pdf",
                    "conversion_generation_id": ATTEMPT_ID,
                    "project_space_id": "space-1",
                },
            )

        self.assertEqual(rows, [{"id": "chunk-1"}])
        insert_sql, parameters = cursor.execute.call_args_list[1].args
        self.assertIn("conversion_generation_id", insert_sql)
        self.assertIn("source_unit_ids", insert_sql)
        self.assertIn("source_locator", insert_sql)
        self.assertIn("content_hash", insert_sql)
        self.assertEqual(parameters[5], ATTEMPT_ID)
        self.assertEqual(parameters[6], list(chunk.source_unit_ids))
        self.assertEqual(json.loads(parameters[7]), chunk.source_locator)
        self.assertEqual(parameters[8], hashlib.sha256(chunk.content.encode()).hexdigest())


if __name__ == "__main__":
    unittest.main()

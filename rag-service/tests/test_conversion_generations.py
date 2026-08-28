import json
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import db

SHA_A = "a" * 64
SHA_B = "b" * 64
SHA_C = "c" * 64
SHA_D = "d" * 64


class _ScriptedCursor:
    def __init__(self, rows):
        self.rows = list(rows)
        self.calls = []
        self.rowcount = 1

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None

    def fetchall(self):
        rows = list(self.rows)
        self.rows.clear()
        return rows


class _FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.commits = 0

    def cursor(self):
        return self._cursor

    def commit(self):
        self.commits += 1


def _fake_connection(cursor):
    @contextmanager
    def factory():
        yield _FakeConnection(cursor)

    return factory


def _generation(**overrides):
    value = {
        "id": "33333333-3333-4333-8333-333333333333",
        "file_id": "file-1",
        "attempt_id": "11111111-1111-4111-8111-111111111111",
        "document_kind": "pdf",
        "source_object_key": "users/u/files/file-1/raw/original.pdf",
        "markdown_object_key": "users/u/files/file-1/derived/g/document.md",
        "source_map_object_key": "users/u/files/file-1/derived/g/source-map.jsonl.zst",
        "manifest_object_key": "users/u/files/file-1/derived/g/manifest.json",
        "converter_name": "pdf-local",
        "converter_version": "1.0.0",
        "conversion_profile": "pdf-text-v1",
        "source_hash": SHA_A,
        "status": "converting",
    }
    value.update(overrides)
    return value


def _create_kwargs():
    generation = _generation()
    return {
        "generation_id": generation["id"],
        "document_kind": generation["document_kind"],
        "source_object_key": generation["source_object_key"],
        "markdown_object_key": generation["markdown_object_key"],
        "source_map_object_key": generation["source_map_object_key"],
        "manifest_object_key": generation["manifest_object_key"],
        "converter_name": generation["converter_name"],
        "converter_version": generation["converter_version"],
        "conversion_profile": generation["conversion_profile"],
        "source_hash": generation["source_hash"],
    }


class ConversionGenerationMigrationTests(unittest.TestCase):
    def test_followup_migration_enforces_same_file_references_and_artifact_integrity(self):
        migration = (
            Path(__file__).resolve().parents[2]
            / "server"
            / "migrations"
            / "0033_conversion_generation_integrity.sql"
        ).read_text(encoding="utf-8").lower()

        for column in (
            "source_map_hash text",
            "manifest_hash text",
            "markdown_byte_size bigint",
            "source_map_byte_size bigint",
            "manifest_byte_size bigint",
            "error_code text",
        ):
            self.assertIn(column, migration)
        self.assertIn("on file_conversion_generations(id, file_id)", migration)
        self.assertIn("on file_conversion_generations(attempt_id)", migration)
        self.assertIn("where attempt_id is not null", migration)
        self.assertIn(
            "foreign key (active_conversion_generation_id, id)\n  references file_conversion_generations(id, file_id)",
            migration,
        )
        self.assertIn(
            "foreign key (conversion_generation_id, file_id)\n  references file_conversion_generations(id, file_id)",
            migration,
        )
        self.assertIn("on delete set null (active_conversion_generation_id)", migration)
        self.assertIn("on delete set null (conversion_generation_id)", migration)
        self.assertIn("file_chunks_conversion_generation_fk", migration)
        self.assertIn("on delete cascade", migration)
        self.assertIn("file_conversion_generations_artifact_integrity_check", migration)
        self.assertIn("status in ('completed', 'completed_with_warnings', 'superseded')", migration)
        for field in (
            "markdown_hash",
            "source_map_hash",
            "manifest_hash",
            "markdown_byte_size",
            "source_map_byte_size",
            "manifest_byte_size",
        ):
            self.assertIn(f"and {field} is not null", migration)
        self.assertIn("status = 'failed'\n      and error_code is not null", migration)


class ConversionGenerationDatabaseTests(unittest.TestCase):
    attempt_id = "11111111-1111-4111-8111-111111111111"
    lease_token = "22222222-2222-4222-8222-222222222222"

    def test_get_file_returns_conversion_routing_and_active_generation_fields(self):
        expected = {"id": "file-1", "conversion_profile": "pdf-text-v1"}
        cursor = _ScriptedCursor([expected])

        with patch.object(db, "get_conn", _fake_connection(cursor)):
            result = db.get_file("file-1")

        sql, params = cursor.calls[0]
        self.assertEqual(result, expected)
        self.assertEqual(params, ("file-1",))
        self.assertIn("target_file.document_kind", sql)
        self.assertIn("target_file.declared_mime_type", sql)
        self.assertIn("target_file.detected_mime_type", sql)
        self.assertIn("target_file.active_conversion_generation_id", sql)
        self.assertIn("claim.conversion_profile", sql)
        self.assertIn("when 'pdf' then 'pdf-text-v1'", sql)
        self.assertIn("left join file_content_claims claim", sql)

    def test_starting_an_attempt_clears_an_inherited_generation_binding(self):
        cursor = _ScriptedCursor([])
        connection = _FakeConnection(cursor)

        @contextmanager
        def fake_conn():
            yield connection

        with patch.object(db, "get_conn", fake_conn):
            db.start_ingestion_job(
                {"id": "file-1"},
                self.attempt_id,
                self.lease_token,
            )

        sql, _ = cursor.calls[0]
        self.assertIn("conversion_generation_id = null", sql)
        self.assertEqual(connection.commits, 1)

    def test_create_generation_inserts_once_and_binds_the_current_lease(self):
        generation = _generation()
        cursor = _ScriptedCursor([
            {"file_id": "file-1"},
            None,
            generation,
            {"file_id": "file-1"},
        ])
        connection = _FakeConnection(cursor)

        @contextmanager
        def fake_conn():
            yield connection

        with patch.object(db, "get_conn", fake_conn):
            result = db.create_or_reuse_conversion_generation(
                "file-1",
                self.attempt_id,
                self.lease_token,
                **_create_kwargs(),
            )

        self.assertEqual(result["id"], generation["id"])
        self.assertEqual(connection.commits, 1)
        self.assertEqual(len(cursor.calls), 4)
        self.assertIn("insert into file_conversion_generations", cursor.calls[2][0])
        self.assertIn("conversion_generation_id = %s", cursor.calls[3][0])
        self.assertEqual(cursor.calls[3][1][0], generation["id"])

    def test_create_generation_stops_before_insert_when_lease_is_inactive(self):
        cursor = _ScriptedCursor([None])
        connection = _FakeConnection(cursor)

        @contextmanager
        def fake_conn():
            yield connection

        with patch.object(db, "get_conn", fake_conn):
            with self.assertRaises(db.IngestionLeaseLostError):
                db.create_or_reuse_conversion_generation(
                    "file-1",
                    self.attempt_id,
                    self.lease_token,
                    **_create_kwargs(),
                )

        self.assertEqual(len(cursor.calls), 1)
        self.assertEqual(connection.commits, 0)

    def test_create_generation_reuses_the_same_attempt_without_an_insert(self):
        generation = _generation()
        cursor = _ScriptedCursor([
            {"file_id": "file-1"},
            generation,
            {"file_id": "file-1"},
        ])
        connection = _FakeConnection(cursor)

        @contextmanager
        def fake_conn():
            yield connection

        with patch.object(db, "get_conn", fake_conn):
            result = db.create_or_reuse_conversion_generation(
                "file-1",
                self.attempt_id,
                self.lease_token,
                **_create_kwargs(),
            )

        self.assertEqual(result, generation)
        self.assertFalse(any("insert into file_conversion_generations" in sql for sql, _ in cursor.calls))
        self.assertEqual(connection.commits, 1)

    def test_create_generation_rejects_immutable_attempt_mismatch(self):
        cursor = _ScriptedCursor([
            {"file_id": "file-1"},
            _generation(source_object_key="unexpected"),
        ])

        with patch.object(db, "get_conn", _fake_connection(cursor)):
            with self.assertRaises(db.ConversionGenerationStateError):
                db.create_or_reuse_conversion_generation(
                    "file-1",
                    self.attempt_id,
                    self.lease_token,
                    **_create_kwargs(),
                )

        self.assertFalse(any("conversion_generation_id = %s" in sql for sql, _ in cursor.calls))

    def test_complete_generation_writes_hashes_sizes_and_warning_status_under_lease(self):
        completed = _generation(status="completed_with_warnings")
        cursor = _ScriptedCursor([completed])
        connection = _FakeConnection(cursor)

        @contextmanager
        def fake_conn():
            yield connection

        with patch.object(db, "get_conn", fake_conn):
            result = db.complete_conversion_generation(
                "file-1",
                completed["id"],
                self.attempt_id,
                self.lease_token,
                markdown_hash=SHA_B,
                source_map_hash=SHA_C,
                manifest_hash=SHA_D,
                markdown_byte_size=100,
                source_map_byte_size=200,
                manifest_byte_size=300,
                warnings=("XLSX_EXTERNAL_LINKS_IGNORED",),
                unit_count=4,
            )

        sql, params = cursor.calls[0]
        self.assertEqual(result, completed)
        self.assertIn("job.conversion_generation_id = generation.id", sql)
        self.assertIn("job.lease_expires_at > now()", sql)
        self.assertIn("source_map_hash = %s", sql)
        self.assertIn("manifest_byte_size = %s", sql)
        self.assertIn("completed_with_warnings", params)
        self.assertEqual(connection.commits, 1)

    def test_complete_generation_idempotently_replays_the_same_terminal_values(self):
        completed = _generation(
            status="completed",
            markdown_hash=SHA_B,
            source_map_hash=SHA_C,
            manifest_hash=SHA_D,
            markdown_byte_size=100,
            source_map_byte_size=200,
            manifest_byte_size=300,
            warning_count=0,
            unit_count=4,
        )
        cursor = _ScriptedCursor([None, completed])
        connection = _FakeConnection(cursor)

        @contextmanager
        def fake_conn():
            yield connection

        with patch.object(db, "get_conn", fake_conn):
            result = db.complete_conversion_generation(
                "file-1",
                completed["id"],
                self.attempt_id,
                self.lease_token,
                markdown_hash=SHA_B,
                source_map_hash=SHA_C,
                manifest_hash=SHA_D,
                markdown_byte_size=100,
                source_map_byte_size=200,
                manifest_byte_size=300,
                warnings=(),
                unit_count=4,
            )

        self.assertEqual(result, completed)
        self.assertEqual(len(cursor.calls), 2)
        self.assertIn("generation.status = 'converting'", cursor.calls[0][0])
        self.assertIn("for update of generation, job", cursor.calls[1][0])
        self.assertEqual(connection.commits, 1)

    def test_complete_generation_rejects_a_mismatched_terminal_replay(self):
        completed = _generation(
            status="completed",
            markdown_hash=SHA_B,
            source_map_hash=SHA_C,
            manifest_hash=SHA_D,
            markdown_byte_size=999,
            source_map_byte_size=200,
            manifest_byte_size=300,
            warning_count=0,
            unit_count=4,
        )
        cursor = _ScriptedCursor([None, completed])

        with patch.object(db, "get_conn", _fake_connection(cursor)), self.assertRaisesRegex(
            db.ConversionGenerationStateError,
            "markdown_byte_size",
        ):
            db.complete_conversion_generation(
                "file-1",
                completed["id"],
                self.attempt_id,
                self.lease_token,
                markdown_hash=SHA_B,
                source_map_hash=SHA_C,
                manifest_hash=SHA_D,
                markdown_byte_size=100,
                source_map_byte_size=200,
                manifest_byte_size=300,
                warnings=(),
                unit_count=4,
            )

    def test_fail_generation_persists_only_a_stable_error_code(self):
        failed = _generation(status="failed", error_code="PDF_NO_TEXT_LAYER")
        cursor = _ScriptedCursor([failed])

        with patch.object(db, "get_conn", _fake_connection(cursor)):
            result = db.fail_conversion_generation(
                "file-1",
                failed["id"],
                self.attempt_id,
                self.lease_token,
                "pdf_no_text_layer",
            )

        sql, params = cursor.calls[0]
        self.assertEqual(result, failed)
        self.assertIn("error_code = %s", sql)
        self.assertEqual(params[0], "PDF_NO_TEXT_LAYER")
        self.assertNotIn("error_message", sql)

    def test_generation_terminal_transition_rejects_an_inactive_lease(self):
        cursor = _ScriptedCursor([None])

        with patch.object(db, "get_conn", _fake_connection(cursor)):
            with self.assertRaises(db.IngestionLeaseLostError):
                db.complete_conversion_generation(
                    "file-1",
                    _generation()["id"],
                    self.attempt_id,
                    self.lease_token,
                    markdown_hash=SHA_B,
                    source_map_hash=SHA_C,
                    manifest_hash=SHA_D,
                    markdown_byte_size=100,
                    source_map_byte_size=200,
                    manifest_byte_size=300,
                    warnings=(),
                    unit_count=4,
                )

        self.assertIn("job.lease_expires_at > now()", cursor.calls[0][0])

    def test_activation_is_atomic_and_supersedes_the_previous_generation(self):
        old_generation_id = "44444444-4444-4444-8444-444444444444"
        generation_id = _generation()["id"]
        cursor = _ScriptedCursor([
            {
                "id": generation_id,
                "warning_count": 2,
                "user_id": "user-1",
                "project_space_id": "space-1",
                "active_conversion_generation_id": old_generation_id,
                "persisted_chunk_count": 2,
            },
            {
                **_generation(),
                "id": old_generation_id,
                "file_id": "file-1",
                "status": "superseded",
            },
            {"id": "file-1"},
            {"id": "space-1", "user_id": "user-1", "knowledge_version": 8},
            {"has_legacy_chunks": False},
            {"vector_version": 3, "bm25_version": 4, "graph_version": 5},
            {"file_id": "file-1"},
        ])
        connection = _FakeConnection(cursor)

        @contextmanager
        def fake_conn():
            yield connection

        with patch.object(db, "get_conn", fake_conn):
            result = db.activate_conversion_generation_and_complete_ingestion_job(
                "file-1",
                generation_id,
                self.attempt_id,
                self.lease_token,
                total_chunks=2,
                indexed_chunks=2,
                keyword_batches=1,
                graph_batches=1,
                vector_batches=1,
                checkpoint={"complete": True},
                detected_mime_type="application/pdf",
            )

        self.assertEqual(result["previous_conversion_generation_id"], old_generation_id)
        self.assertEqual(result["publication"]["knowledge_version"], 8)
        self.assertEqual(connection.commits, 1)
        self.assertEqual(len(cursor.calls), 9)
        self.assertIn("status = 'superseded'", cursor.calls[1][0])
        self.assertIn("active_conversion_generation_id = %s", cursor.calls[2][0])
        self.assertEqual(cursor.calls[2][1], (generation_id, "application/pdf", 2, "file-1"))
        self.assertIn("knowledge_version = knowledge_version + 1", cursor.calls[3][0])
        self.assertIn("insert into rag_index_versions", cursor.calls[5][0])
        self.assertIn("delete from rag_retrieval_cache", cursor.calls[6][0])
        self.assertIn("status = 'completed'", cursor.calls[7][0])
        self.assertIn("conversion_generation_id = %s", cursor.calls[7][0])
        self.assertIn("'conversion_generation'", cursor.calls[8][0])
        cleanup_payload = json.loads(cursor.calls[8][1][3])
        self.assertEqual(cleanup_payload["file_id"], "file-1")
        self.assertEqual(
            cleanup_payload["storage_object_keys"],
            [
                "users/u/files/file-1/derived/g/document.md",
                "users/u/files/file-1/derived/g/source-map.jsonl.zst",
                "users/u/files/file-1/derived/g/manifest.json",
            ],
        )
        self.assertNotIn("source_object_key", cleanup_payload)

    def test_activation_rejects_missing_or_partial_generation_chunks(self):
        cursor = _ScriptedCursor([{
            "id": _generation()["id"],
            "warning_count": 0,
            "active_conversion_generation_id": None,
            "persisted_chunk_count": 1,
        }])
        connection = _FakeConnection(cursor)

        @contextmanager
        def fake_conn():
            yield connection

        with patch.object(db, "get_conn", fake_conn):
            with self.assertRaises(db.ConversionGenerationStateError):
                db.activate_conversion_generation_and_complete_ingestion_job(
                    "file-1",
                    _generation()["id"],
                    self.attempt_id,
                    self.lease_token,
                    total_chunks=2,
                    indexed_chunks=2,
                )

        self.assertEqual(connection.commits, 0)
        self.assertEqual(len(cursor.calls), 1)

    def test_cleanup_targets_preserve_ids_and_reject_the_active_generation(self):
        generation_id = _generation()["id"]
        active_cursor = _ScriptedCursor([{
            "status": "superseded",
            "active_conversion_generation_id": generation_id,
        }])
        with patch.object(db, "get_conn", _fake_connection(active_cursor)):
            with self.assertRaises(db.ConversionGenerationStateError):
                db.get_cleanup_conversion_generation_chunk_ids(
                    "file-1",
                    generation_id,
                )
        self.assertEqual(len(active_cursor.calls), 1)

        cleanup_cursor = _ScriptedCursor([
            {"status": "failed", "active_conversion_generation_id": None},
            {"id": "chunk-1"},
            {"id": "chunk-2"},
        ])
        with patch.object(db, "get_conn", _fake_connection(cleanup_cursor)):
            chunk_ids = db.get_cleanup_conversion_generation_chunk_ids(
                "file-1",
                generation_id,
            )
        self.assertEqual(chunk_ids, ["chunk-1", "chunk-2"])
        self.assertIn("conversion_generation_id = %s", cleanup_cursor.calls[1][0])

    def test_cleanup_endpoint_deletes_external_indexes_without_deleting_postgres(self):
        import main

        request = main.CleanupConversionGenerationRequest(
            file_id="11111111-1111-4111-8111-111111111111",
            generation_id="33333333-3333-4333-8333-333333333333",
        )
        with patch.object(
            main,
            "get_cleanup_conversion_generation_chunk_ids",
            return_value=["chunk-1", "chunk-2"],
        ), patch.object(main, "delete_chunk_vectors") as delete_vectors, patch.object(
            main,
            "delete_chunk_keywords",
        ) as delete_keywords, patch.object(main, "delete_chunk_graph") as delete_graph:
            result = main.cleanup_conversion_generation_endpoint(request)

        self.assertEqual(result["chunk_count"], 2)
        delete_vectors.assert_called_once_with(["chunk-1", "chunk-2"])
        delete_keywords.assert_called_once_with(["chunk-1", "chunk-2"])
        delete_graph.assert_called_once_with(
            "11111111-1111-4111-8111-111111111111",
            ["chunk-1", "chunk-2"],
        )


class ConversionWarningDetailTests(unittest.TestCase):
    attempt_id = "11111111-1111-4111-8111-111111111111"
    lease_token = "22222222-2222-4222-8222-222222222222"

    def _complete(self, warnings, status="completed_with_warnings"):
        completed = _generation(status=status)
        cursor = _ScriptedCursor([completed])
        with patch.object(db, "get_conn", _fake_connection(cursor)):
            db.complete_conversion_generation(
                "file-1",
                completed["id"],
                self.attempt_id,
                self.lease_token,
                markdown_hash=SHA_B,
                source_map_hash=SHA_C,
                manifest_hash=SHA_D,
                markdown_byte_size=100,
                source_map_byte_size=200,
                manifest_byte_size=300,
                warnings=warnings,
                unit_count=4,
            )
        return cursor.calls[0]

    def test_the_warning_codes_are_persisted_next_to_their_count(self):
        # Only the count was stored before, so answering "why did this document
        # convert with warnings" meant downloading the manifest artifact.
        sql, params = self._complete(("PDF_COMPLEX_LAYOUT_MAY_BE_LOSSY", "DOCX_IMAGES_IGNORED"))
        self.assertIn("warnings = %s", sql)
        self.assertIn(["PDF_COMPLEX_LAYOUT_MAY_BE_LOSSY", "DOCX_IMAGES_IGNORED"], params)
        self.assertIn(2, params)
        self.assertIn("completed_with_warnings", params)

    def test_the_count_is_derived_from_the_codes_so_they_cannot_disagree(self):
        _, params = self._complete(("XLSX_EXTERNAL_LINKS_IGNORED",))
        self.assertIn(1, params)
        self.assertIn(["XLSX_EXTERNAL_LINKS_IGNORED"], params)

        _, clean_params = self._complete((), status="completed")
        self.assertIn(0, clean_params)
        self.assertIn([], clean_params)
        self.assertIn("completed", clean_params)
        self.assertNotIn("completed_with_warnings", clean_params)

    def test_unusable_warning_codes_are_rejected(self):
        for invalid in (("",), ("   ",), ("x" * 201,), (None,), (7,), "not-a-sequence"):
            with self.assertRaises(ValueError):
                self._complete(invalid)

    def test_the_migration_adds_a_queryable_warning_column(self):
        migration = (
            Path(__file__).resolve().parents[2]
            / "server"
            / "migrations"
            / "0043_conversion_warning_details.sql"
        ).read_text(encoding="utf-8").lower()
        self.assertIn("add column if not exists warnings text[]", migration)
        # Legacy rows keep an empty array with a non-zero count, so only
        # non-empty arrays are required to match the count.
        self.assertIn("cardinality(warnings) = 0 or cardinality(warnings) = warning_count", migration)

    def test_generation_reads_expose_the_warning_codes(self):
        self.assertIn("warnings", db._CONVERSION_GENERATION_COLUMNS)


if __name__ == "__main__":
    unittest.main()

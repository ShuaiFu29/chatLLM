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
                warning_count=1,
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
                    warning_count=0,
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
        self.assertEqual(len(cursor.calls), 8)
        self.assertIn("status = 'superseded'", cursor.calls[1][0])
        self.assertIn("active_conversion_generation_id = %s", cursor.calls[2][0])
        self.assertEqual(cursor.calls[2][1], (generation_id, "application/pdf", 2, "file-1"))
        self.assertIn("knowledge_version = knowledge_version + 1", cursor.calls[3][0])
        self.assertIn("insert into rag_index_versions", cursor.calls[5][0])
        self.assertIn("delete from rag_retrieval_cache", cursor.calls[6][0])
        self.assertIn("status = 'completed'", cursor.calls[7][0])
        self.assertIn("conversion_generation_id = %s", cursor.calls[7][0])

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


if __name__ == "__main__":
    unittest.main()

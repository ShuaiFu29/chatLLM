import inspect
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import db
import ingestion


class _FakeCursor:
    def __init__(self, rowcount=0, row=None):
        self.rowcount = rowcount
        self.row = row
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))

    def fetchone(self):
        return self.row


class _FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.commits = 0

    def cursor(self):
        return self._cursor

    def commit(self):
        self.commits += 1


class IngestionLeaseTests(unittest.TestCase):
    attempt_id = "11111111-1111-4111-8111-111111111111"
    lease_token = "22222222-2222-4222-8222-222222222222"

    def test_assertion_rejects_a_missing_current_lease(self):
        self.assertTrue(hasattr(db, "assert_ingestion_lease"))
        cursor = _FakeCursor(row=None)
        connection = _FakeConnection(cursor)

        @contextmanager
        def fake_conn():
            yield connection

        with patch.object(db, "get_conn", fake_conn):
            with self.assertRaises(db.IngestionLeaseLostError):
                db.assert_ingestion_lease("file-1", self.attempt_id, self.lease_token)

        sql, params = cursor.calls[0]
        self.assertIn("status = 'processing'", sql)
        self.assertIn("lease_expires_at > now()", sql)
        self.assertEqual(params, ("file-1", self.attempt_id, self.lease_token))

    def test_checkpoint_update_rejects_a_replaced_or_expired_lease(self):
        self.assertTrue(hasattr(db, "IngestionLeaseLostError"))
        self.assertTrue(hasattr(db, "update_ingestion_job_checkpoint"))

        cursor = _FakeCursor(rowcount=0)
        connection = _FakeConnection(cursor)

        @contextmanager
        def fake_conn():
            yield connection

        with patch.object(db, "get_conn", fake_conn):
            with self.assertRaises(db.IngestionLeaseLostError):
                db.update_ingestion_job_checkpoint(
                    "file-1",
                    self.attempt_id,
                    self.lease_token,
                    stage="indexing_vectors",
                    progress=50,
                )

        sql, params = cursor.calls[0]
        self.assertIn("attempt_id", sql)
        self.assertIn("lease_token", sql)
        self.assertIn("lease_expires_at > now()", sql)
        self.assertEqual(params[-2:], (
            self.attempt_id,
            self.lease_token,
        ))

    def test_terminal_job_updates_reject_replaced_or_expired_leases(self):
        cases = [
            (
                db.complete_ingestion_job,
                {
                    "stage": "completed",
                    "total_chunks": 1,
                    "indexed_chunks": 1,
                },
            ),
            (
                db.fail_ingestion_job,
                {"error_message": "safe failure"},
            ),
        ]

        for operation, kwargs in cases:
            with self.subTest(operation=operation.__name__):
                cursor = _FakeCursor(rowcount=0)
                connection = _FakeConnection(cursor)

                @contextmanager
                def fake_conn():
                    yield connection

                with patch.object(db, "get_conn", fake_conn):
                    with self.assertRaises(db.IngestionLeaseLostError):
                        operation(
                            "file-1",
                            self.attempt_id,
                            self.lease_token,
                            **kwargs,
                        )

                sql, params = cursor.calls[0]
                self.assertIn("attempt_id", sql)
                self.assertIn("lease_token", sql)
                self.assertIn("status = 'processing'", sql)
                self.assertIn("lease_expires_at > now()", sql)
                self.assertEqual(params[-2:], (self.attempt_id, self.lease_token))

    def test_process_file_stops_before_side_effects_when_lease_is_lost(self):
        self.assertIn("attempt_id", inspect.signature(ingestion.process_file).parameters)
        self.assertIn("lease_token", inspect.signature(ingestion.process_file).parameters)
        lease_error = getattr(db, "IngestionLeaseLostError", RuntimeError)

        with patch("ingestion.assert_ingestion_lease", side_effect=lease_error("lost"), create=True), patch(
            "ingestion.get_file"
        ) as get_file_mock, patch("ingestion.fail_ingestion_job") as fail_job_mock:
            with self.assertRaises(lease_error):
                ingestion.process_file(
                    "file-1",
                    self.attempt_id,
                    self.lease_token,
                )

        get_file_mock.assert_not_called()
        fail_job_mock.assert_not_called()

    def test_python_ingestion_owns_checkpoints_but_never_files_status(self):
        source = Path(ingestion.__file__).read_text(encoding="utf-8")
        main_source = Path(ingestion.__file__).with_name("main.py").read_text(encoding="utf-8")

        self.assertNotIn("update_file_status", source)
        self.assertNotIn("update_file_progress", source)
        self.assertRegex(main_source, r"class IngestRequest[\s\S]*attempt_id")
        self.assertRegex(main_source, r"class IngestRequest[\s\S]*lease_token")
        self.assertRegex(main_source, r"process_file\(request\.file_id, request\.attempt_id, request\.lease_token\)")


if __name__ == "__main__":
    unittest.main()

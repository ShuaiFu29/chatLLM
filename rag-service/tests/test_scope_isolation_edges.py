"""Fail-closed behaviour for workspace scoping and pool exhaustion.

Covers the batch F defects: a Milvus probe failure must not silently disable
workspace filtering, an unknown workspace must not get invented version numbers,
and the connection pool must honour its timeout without recursing.
"""

import time
import unittest
from queue import LifoQueue
from unittest.mock import MagicMock, patch

import database_pool
import db
import vector_store


class MilvusProjectSpaceProbeTests(unittest.TestCase):
    def setUp(self):
        vector_store._project_space_field_available = None

    def tearDown(self):
        vector_store._project_space_field_available = None

    def test_probe_failure_does_not_disable_workspace_filtering(self):
        """P2-MILVUS-PROBE: caching False on error dropped the scope predicate."""
        client = MagicMock()
        client.describe_collection.side_effect = RuntimeError("milvus unavailable")

        with patch("vector_store.get_client", return_value=client):
            with self.assertRaisesRegex(RuntimeError, "refusing to run an unscoped search"):
                vector_store._has_project_space_field()

        # Nothing may be cached: a transient outage must not permanently mark the
        # collection as unscoped for the rest of the process lifetime.
        self.assertIsNone(vector_store._project_space_field_available)

    def test_a_recovered_probe_is_used_and_cached(self):
        client = MagicMock()
        client.describe_collection.side_effect = [
            RuntimeError("milvus unavailable"),
            {"fields": [{"name": "project_space_id"}, {"name": "embedding"}]},
        ]

        with patch("vector_store.get_client", return_value=client):
            with self.assertRaises(RuntimeError):
                vector_store._has_project_space_field()
            self.assertTrue(vector_store._has_project_space_field())
            # The successful answer is cached, so the third call adds no describe.
            self.assertTrue(vector_store._has_project_space_field())

        self.assertEqual(client.describe_collection.call_count, 2)

    def test_a_collection_without_the_field_is_reported_as_missing(self):
        client = MagicMock()
        client.describe_collection.return_value = {"fields": [{"name": "embedding"}]}

        with patch("vector_store.get_client", return_value=client):
            self.assertFalse(vector_store._has_project_space_field())


class RetrievalScopeTests(unittest.TestCase):
    def test_unknown_project_space_does_not_get_invented_versions(self):
        """P3-MISSING-SPACE: `knowledge_version: 1` collided across scopes."""
        cursor = MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.return_value = None
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.cursor.return_value = cursor

        with patch("db.get_conn", return_value=connection):
            with self.assertRaises(db.UnknownProjectSpaceError):
                db.get_retrieval_scope("user-1", "space-owned-by-someone-else")

        # No index row may be created for a workspace the user does not own.
        statements = " ".join(str(call.args[0]).lower() for call in cursor.execute.call_args_list)
        self.assertNotIn("insert into rag_index_versions", statements)
        connection.commit.assert_not_called()


class ConnectionPoolTests(unittest.TestCase):
    def _pool(self, max_size, timeout_ms):
        pool = database_pool._ConnectionPool(max_size=max_size, timeout_ms=timeout_ms)
        pool._idle = LifoQueue(maxsize=max_size)
        return pool

    def test_closed_idle_connections_are_replaced_without_recursion(self):
        """P3-POOL-RECURSE: each retry restarted the timeout and grew the stack."""
        pool = self._pool(max_size=1, timeout_ms=500)
        closed = MagicMock()
        closed.closed = True
        fresh = MagicMock()
        fresh.closed = False

        # The pool is at capacity and the only idle connection is dead.
        pool._created = 1
        pool._idle.put_nowait(closed)

        with patch.object(pool, "_create_connection", return_value=fresh) as create:
            acquired = pool.acquire()

        self.assertIs(acquired, fresh)
        self.assertEqual(create.call_count, 1)
        self.assertEqual(pool._created, 1)

    def test_the_wait_respects_the_configured_timeout_budget(self):
        pool = self._pool(max_size=1, timeout_ms=120)
        pool._created = 1

        started_at = time.monotonic()
        with self.assertRaisesRegex(TimeoutError, "Timed out waiting"):
            pool.acquire()
        elapsed_ms = (time.monotonic() - started_at) * 1000

        # A single bounded wait, not one full timeout per retry.
        self.assertLess(elapsed_ms, 600, f"acquire waited {elapsed_ms:.0f}ms")

    def test_a_repeatedly_closed_connection_still_times_out_once(self):
        pool = self._pool(max_size=1, timeout_ms=150)
        pool._created = 1

        def closed_connection():
            conn = MagicMock()
            conn.closed = True
            return conn

        pool._idle.put_nowait(closed_connection())

        started_at = time.monotonic()
        with patch.object(pool, "_create_connection", side_effect=lambda: closed_connection()):
            # A replacement that is itself closed must not restart the budget.
            connection = pool.acquire()
        elapsed_ms = (time.monotonic() - started_at) * 1000

        self.assertTrue(connection.closed)
        self.assertLess(elapsed_ms, 600, f"acquire waited {elapsed_ms:.0f}ms")

    def test_a_live_idle_connection_is_returned_immediately(self):
        pool = self._pool(max_size=2, timeout_ms=500)
        live = MagicMock()
        live.closed = False
        pool._created = 1
        pool._idle.put_nowait(live)

        self.assertIs(pool.acquire(), live)


if __name__ == "__main__":
    unittest.main()

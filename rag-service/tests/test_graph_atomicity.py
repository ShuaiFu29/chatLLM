import json
import os
import threading
import unittest
from urllib.parse import urlparse
from unittest.mock import DEFAULT, patch
from uuid import uuid4

import graph_store
import ingestion


ATTEMPT_ID = "11111111-1111-4111-8111-111111111111"
LEASE_TOKEN = "22222222-2222-4222-8222-222222222222"


def file_data(project_space_id="space-1"):
    return {
        "id": "file-1",
        "user_id": "user-1",
        "project_space_id": project_space_id,
        "filename": "notes.md",
        "file_type": "text/markdown",
        "object_key": "uploads/notes.md",
    }


def chunk_rows(count=2):
    return [
        {
            "id": f"chunk-{index + 1}",
            "file_id": "file-1",
            "user_id": "user-1",
            "chunk_index": index,
            "content": f"Service {index + 1} depends on shared runtime.",
        }
        for index in range(count)
    ]


class JsonResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class AtomicNeo4jTransport:
    """Models idempotent auto-commit batches plus compensating Chunk cleanup."""

    def __init__(self):
        self.committed_chunk_ids = []
        self.pending_chunk_ids = []
        self.requests = []

    @staticmethod
    def _chunk_ids(payload):
        result = []
        for statement in payload.get("statements", []):
            parameters = statement.get("parameters") or {}
            result.extend(chunk.get("chunk_id") for chunk in parameters.get("chunks", []))
        return [chunk_id for chunk_id in result if chunk_id]

    @staticmethod
    def _cleanup_chunk_ids(payload):
        result = []
        for statement in payload.get("statements", []):
            parameters = statement.get("parameters") or {}
            result.extend(parameters.get("chunk_ids", []))
        return [chunk_id for chunk_id in result if chunk_id]

    def __call__(self, request, timeout):
        del timeout
        method = request.get_method()
        path = urlparse(request.full_url).path
        payload = json.loads(request.data.decode("utf-8")) if request.data else {"statements": []}
        requested_chunks = self._chunk_ids(payload)
        cleanup_chunks = self._cleanup_chunk_ids(payload)
        self.requests.append((method, path, requested_chunks))

        if path.endswith("/tx/commit"):
            if "chunk-2" in requested_chunks:
                return JsonResponse({"results": [], "errors": [{"message": "later batch failed"}]})
            if cleanup_chunks:
                self.committed_chunk_ids = [
                    chunk_id for chunk_id in self.committed_chunk_ids
                    if chunk_id not in cleanup_chunks
                ]
            self.committed_chunk_ids.extend(requested_chunks)
            return JsonResponse({"results": [], "errors": []})

        raise AssertionError(f"Unexpected Neo4j request: {method} {path}")


class FakeGraphFileTransaction:
    def __init__(self):
        self.entered = 0
        self.pending_batches = 0
        self.committed_batches = 0
        self.status = "pending"

    def __enter__(self):
        self.entered += 1
        return self

    def __exit__(self, exc_type, _exc, _traceback):
        if exc_type is None:
            self.committed_batches = self.pending_batches
            self.status = "indexed"
        else:
            self.status = "failed"
        return False


class GraphAtomicityTests(unittest.TestCase):
    def test_file_graph_coordinators_do_not_serialize_independent_ingestions(self):
        first = graph_store.GraphFileTransaction()
        second_entered = threading.Event()

        def enter_second():
            with graph_store.GraphFileTransaction():
                second_entered.set()

        with patch.object(graph_store.settings, "neo4j_enabled", True):
            first.enabled = True
            first.__enter__()
            worker = threading.Thread(target=enter_second, daemon=True)
            worker.start()
            self.assertTrue(second_entered.wait(1))
            first.__exit__(None, None, None)
            worker.join(timeout=1)

        self.assertFalse(worker.is_alive())

    def test_global_scope_is_normalized_to_a_non_null_key(self):
        facts = graph_store.extract_graph_facts(file_data(None), chunk_rows(1))

        self.assertEqual(facts["document"]["scope_key"], "__global__")
        self.assertEqual(facts["chunks"][0]["scope_key"], "__global__")
        self.assertTrue(facts["entities"])
        self.assertTrue(all(entity["scope_key"] == "__global__" for entity in facts["entities"]))
        scoped_relations = [rel for rel in facts["relationships"] if "user_id" in rel]
        self.assertTrue(scoped_relations)
        self.assertTrue(all(rel["scope_key"] == "__global__" for rel in scoped_relations))

    def test_later_graph_batch_failure_leaves_no_committed_file_writes(self):
        transport = AtomicNeo4jTransport()
        with patch.object(graph_store.settings, "neo4j_enabled", True), patch.object(
            graph_store.settings,
            "neo4j_batch_size",
            1,
        ), patch("graph_store.ensure_graph_schema"), patch(
            "graph_store.urllib.request.urlopen",
            side_effect=transport,
        ):
            with self.assertRaisesRegex(RuntimeError, "later batch failed"):
                graph_store.index_graph_chunks(file_data(), chunk_rows(2))

        self.assertEqual(transport.committed_chunk_ids, [])
        self.assertEqual(transport.pending_chunk_ids, [])

    def test_transient_neo4j_error_is_retried_with_finite_backoff(self):
        transient = graph_store.Neo4jQueryError(
            "relationship group deadlock",
            "Neo.TransientError.Transaction.DeadlockDetected",
        )
        with patch.object(graph_store.settings, "neo4j_enabled", True), patch(
            "graph_store._neo4j_request",
            side_effect=[transient, {"results": [], "errors": []}],
        ) as request, patch("graph_store.random.uniform", return_value=0), patch(
            "graph_store.time.sleep"
        ) as sleep:
            self.assertEqual(graph_store._run_cypher("RETURN 1"), [])

        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(graph_store.NEO4J_TRANSIENT_RETRY_BASE_SECONDS)

    def test_transient_neo4j_retry_stops_at_the_configured_attempt_limit(self):
        transient = graph_store.Neo4jQueryError(
            "relationship group deadlock",
            "Neo.TransientError.Transaction.DeadlockDetected",
        )
        with patch.object(graph_store.settings, "neo4j_enabled", True), patch(
            "graph_store._neo4j_request",
            side_effect=transient,
        ) as request, patch("graph_store.random.uniform", return_value=0), patch(
            "graph_store.time.sleep"
        ) as sleep, self.assertRaises(graph_store.Neo4jQueryError):
            graph_store._run_cypher("RETURN 1")

        self.assertEqual(request.call_count, graph_store.NEO4J_TRANSIENT_RETRY_ATTEMPTS)
        self.assertEqual(sleep.call_count, graph_store.NEO4J_TRANSIENT_RETRY_ATTEMPTS - 1)

    def test_enabled_graph_failure_propagates_out_of_ingestion(self):
        with patch.object(ingestion.settings, "neo4j_enabled", True), patch(
            "ingestion.index_chunks"
        ), patch(
            "ingestion.index_graph_chunks",
            side_effect=RuntimeError("neo4j unavailable"),
        ), patch(
            "ingestion.get_embeddings",
            return_value=[[0.1, 0.2]],
        ), patch(
            "ingestion.insert_vectors",
            side_effect=lambda rows: len(rows),
        ):
            with self.assertRaisesRegex(RuntimeError, "neo4j unavailable"):
                ingestion.index_chunk_batch(file_data(), chunk_rows(1), "space-1")

    def test_disabled_graph_indexing_returns_and_records_skipped_state(self):
        with patch.object(graph_store.settings, "neo4j_enabled", False), patch(
            "graph_store.urllib.request.urlopen"
        ) as urlopen:
            result = graph_store.index_graph_chunks(file_data(), chunk_rows(1))

        self.assertEqual(result, {"status": "skipped", "batches": 0})
        urlopen.assert_not_called()

        with patch("ingestion.index_chunks"), patch(
            "ingestion.index_graph_chunks",
            return_value={"status": "skipped", "batches": 0},
        ), patch(
            "ingestion.get_embeddings",
            return_value=[[0.1, 0.2]],
        ), patch(
            "ingestion.insert_vectors",
            side_effect=lambda rows: len(rows),
        ):
            stats = ingestion.index_chunk_batch(file_data(), chunk_rows(1), "space-1")

        self.assertEqual(stats["graph_status"], "skipped")
        self.assertEqual(stats["graph_batches"], 0)

    def test_ingestion_uses_one_graph_publication_coordinator_across_file_batches(self):
        rows = chunk_rows(2)
        transaction = FakeGraphFileTransaction()

        def fake_graph_index(_file_data, _rows, *, transaction=None):
            if transaction is not None:
                transaction.pending_batches += 1
                return {"status": "pending", "batches": 0}
            return {"status": "indexed", "batches": 1}

        with patch.multiple(
            "ingestion",
            start_ingestion_job=DEFAULT,
            update_ingestion_job_checkpoint=DEFAULT,
            fail_ingestion_job=DEFAULT,
            assert_ingestion_lease=DEFAULT,
        ), patch("ingestion.complete_ingestion_job") as complete_job, patch(
            "ingestion.graph_file_transaction",
            return_value=transaction,
            create=True,
        ) as transaction_factory, patch.object(
            ingestion.settings,
            "rag_ingest_chunk_batch_size",
            1,
        ), patch(
            "ingestion.get_file",
            return_value=file_data(),
        ), patch(
            "ingestion.download_object",
            return_value=b"# Notes",
        ), patch(
            "ingestion.extract_text",
            return_value=("# Notes", True),
        ), patch(
            "ingestion.split_text",
            return_value=["first", "second"],
        ), patch(
            "ingestion.reset_file_indexes"
        ), patch(
            "ingestion.replace_file_chunks",
            return_value=rows,
        ), patch(
            "ingestion.index_chunks"
        ), patch(
            "ingestion.index_graph_chunks",
            side_effect=fake_graph_index,
        ) as graph_index, patch(
            "ingestion.get_embeddings",
            side_effect=lambda texts: [[0.1, 0.2] for _ in texts],
        ), patch(
            "ingestion.insert_vectors",
            side_effect=lambda vectors: len(vectors),
        ), patch(
            "ingestion.bump_project_knowledge_version"
        ):
            result = ingestion.process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        self.assertEqual(result, {"status": "success", "chunks": 2})
        transaction_factory.assert_called_once_with()
        self.assertEqual(transaction.entered, 1)
        self.assertEqual(graph_index.call_count, 2)
        self.assertTrue(all(call.kwargs.get("transaction") is transaction for call in graph_index.call_args_list))
        completion = complete_job.call_args.kwargs
        self.assertEqual(completion["graph_batches"], 2)
        self.assertEqual(completion["checkpoint"]["graph_status"], "indexed")

    def test_final_lease_loss_rolls_back_graph_before_commit(self):
        rows = chunk_rows(1)
        transaction = FakeGraphFileTransaction()
        lease_checks = 0

        def assert_lease(*_args):
            nonlocal lease_checks
            lease_checks += 1
            if lease_checks == 4:
                raise ingestion.IngestionLeaseLostError("lease lost before graph commit")

        def fake_graph_index(_file_data, _rows, *, transaction=None):
            if transaction is not None:
                transaction.pending_batches += 1
            return {"status": "pending", "batches": 0}

        with patch("ingestion.start_ingestion_job"), patch(
            "ingestion.update_ingestion_job_checkpoint"
        ), patch(
            "ingestion.fail_ingestion_job"
        ), patch(
            "ingestion.assert_ingestion_lease",
            side_effect=assert_lease,
        ), patch(
            "ingestion.complete_ingestion_job"
        ) as complete_job, patch(
            "ingestion.graph_file_transaction",
            return_value=transaction,
        ), patch(
            "ingestion.get_file",
            return_value=file_data(),
        ), patch(
            "ingestion.download_object",
            return_value=b"# Notes",
        ), patch(
            "ingestion.extract_text",
            return_value=("# Notes", True),
        ), patch(
            "ingestion.split_text",
            return_value=["first"],
        ), patch(
            "ingestion.reset_file_indexes"
        ), patch(
            "ingestion.replace_file_chunks",
            return_value=rows,
        ), patch(
            "ingestion.index_chunks"
        ), patch(
            "ingestion.index_graph_chunks",
            side_effect=fake_graph_index,
        ), patch(
            "ingestion.get_embeddings",
            return_value=[[0.1, 0.2]],
        ), patch(
            "ingestion.insert_vectors",
            side_effect=lambda vectors: len(vectors),
        ), patch(
            "ingestion.bump_project_knowledge_version"
        ):
            with self.assertRaises(ingestion.IngestionLeaseLostError):
                ingestion.process_file("file-1", ATTEMPT_ID, LEASE_TOKEN)

        self.assertEqual(transaction.status, "failed")
        self.assertEqual(transaction.committed_batches, 0)
        complete_job.assert_not_called()

    def test_cleanup_removes_only_owner_scoped_orphan_entities(self):
        with patch.object(graph_store.settings, "neo4j_enabled", True), patch(
            "graph_store._run_cypher"
        ) as run_cypher:
            graph_store.delete_file_graph("file-1")

        statements = "\n".join(call.args[0] for call in run_cypher.call_args_list)
        self.assertIn("WHERE NOT (e)--()", statements)
        self.assertIn("e.user_id = owner_user_id", statements)
        self.assertIn("coalesce(e.scope_key", statements)
        self.assertIn("owner_scope_key", statements)

    @unittest.skipUnless(os.environ.get("TEST_NEO4J_URL"), "Neo4j integration is not configured")
    def test_real_neo4j_compensates_late_failure_and_cleans_only_orphans(self):
        unique = uuid4().hex
        user_id = f"audit-user-{unique}"
        scope_id = f"audit-space-{unique}"
        failed_file_id = f"audit-failed-{unique}"
        first_file_id = f"audit-first-{unique}"
        second_file_id = f"audit-second-{unique}"

        failed_file = {
            **file_data(scope_id),
            "id": failed_file_id,
            "user_id": user_id,
        }
        failed_rows = [
            {
                **chunk_rows(1)[0],
                "id": f"audit-failed-chunk-1-{unique}",
                "file_id": failed_file_id,
                "user_id": user_id,
            },
            {
                **chunk_rows(1)[0],
                "id": f"audit-failed-chunk-2-{unique}",
                "file_id": failed_file_id,
                "user_id": user_id,
            },
        ]

        transaction = graph_store.graph_file_transaction()
        with self.assertRaises(RuntimeError):
            with transaction:
                transaction.index_chunks(failed_file, failed_rows[:1])
                with patch.object(graph_store, "_GRAPH_INDEX_STATEMENT", "THIS IS NOT VALID CYPHER"):
                    transaction.index_chunks(failed_file, failed_rows[1:])

        failed_count = graph_store._run_cypher(
            """
            MATCH (d:Document {file_id: $file_id})
            OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
            RETURN {documents: count(distinct d), chunks: count(distinct c)} AS row
            """,
            {"file_id": failed_file_id},
        )[0]
        self.assertEqual(failed_count, {"documents": 0, "chunks": 0})

        first_file = {
            **file_data(scope_id),
            "id": first_file_id,
            "user_id": user_id,
        }
        second_file = {
            **file_data(scope_id),
            "id": second_file_id,
            "user_id": user_id,
        }
        first_rows = [{
            **chunk_rows(1)[0],
            "id": f"audit-first-chunk-{unique}",
            "file_id": first_file_id,
            "user_id": user_id,
            "content": "SharedRuntime supports ClientOne.",
        }]
        second_rows = [{
            **chunk_rows(1)[0],
            "id": f"audit-second-chunk-{unique}",
            "file_id": second_file_id,
            "user_id": user_id,
            "content": "SharedRuntime supports ClientTwo.",
        }]

        try:
            graph_store.index_graph_chunks(first_file, first_rows)
            graph_store.index_graph_chunks(second_file, second_rows)
            graph_store.delete_file_graph(first_file_id)

            remaining_names = graph_store._run_cypher(
                """
                MATCH (e:Entity {user_id: $user_id, scope_key: $scope_key})
                RETURN {names: collect(e.name)} AS row
                """,
                {"user_id": user_id, "scope_key": scope_id},
            )[0]["names"]
            self.assertIn("SharedRuntime", remaining_names)
            self.assertIn("ClientTwo", remaining_names)
            self.assertNotIn("ClientOne", remaining_names)

            graph_store.delete_file_graph(second_file_id)
            remaining_count = graph_store._run_cypher(
                """
                MATCH (e:Entity {user_id: $user_id, scope_key: $scope_key})
                RETURN {count: count(e)} AS row
                """,
                {"user_id": user_id, "scope_key": scope_id},
            )[0]["count"]
            self.assertEqual(remaining_count, 0)
        finally:
            graph_store.delete_file_graph(first_file_id)
            graph_store.delete_file_graph(second_file_id)


if __name__ == "__main__":
    unittest.main()

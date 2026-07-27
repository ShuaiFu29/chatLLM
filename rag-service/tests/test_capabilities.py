import unittest
from contextlib import nullcontext
from unittest.mock import patch

import db
import main
from capabilities import build_capability_report
from config import settings


class _Cursor:
    def __init__(self, row):
        self.row = row
        self.statement = ""
        self.parameters = ()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement, parameters=()):
        self.statement = statement
        self.parameters = parameters

    def fetchone(self):
        return self.row


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class CapabilityTests(unittest.TestCase):
    def test_report_exposes_fallback_modes_and_stale_markdown_without_failing_readiness(self):
        markdown_index = {
            "status": "degraded",
            "current_chunk_strategy_version": db.CHUNK_STRATEGY_VERSION,
            "indexed_file_count": 8,
            "stale_file_count": 2,
            "stale_chunk_count": 5,
            "reindex_required": True,
        }
        with (
            patch.object(settings, "query_rewrite_enabled", False),
            patch.object(settings, "reranker_enabled", False),
            patch.object(settings, "neo4j_enabled", True),
            patch.object(settings, "graph_extraction_enabled", False),
            patch.object(settings, "redis_cache_enabled", False),
            patch.object(settings, "redis_cache_disabled_reason", "CACHE_REDIS_URL is not configured"),
            patch.object(settings, "rag_judge_enabled", False),
        ):
            report = build_capability_report(markdown_index)

        self.assertEqual(report["status"], "degraded")
        self.assertEqual(report["features"]["query_rewrite"]["mode"], "deterministic_multi_turn")
        self.assertEqual(report["features"]["reranker"]["version"], "local-evidence-v2")
        self.assertEqual(report["features"]["graph_extraction"]["mode"], "rules_fallback")
        self.assertTrue(report["features"]["markdown_index"]["reindex_required"])

    def test_markdown_index_status_counts_only_materialized_stale_chunks(self):
        cursor = _Cursor({
            "indexed_file_count": 7,
            "stale_file_count": 2,
            "stale_chunk_count": 9,
        })
        with patch.object(db, "get_conn", return_value=nullcontext(_Connection(cursor))):
            status = db.get_markdown_index_status()

        self.assertEqual(cursor.parameters, (db.CHUNK_STRATEGY_VERSION,))
        self.assertIn("files.status = 'completed'", cursor.statement)
        self.assertEqual(status["status"], "degraded")
        self.assertEqual(status["stale_file_count"], 2)
        self.assertEqual(status["stale_chunk_count"], 9)
        self.assertTrue(status["reindex_required"])

    def test_cache_redis_failure_degrades_l1_without_failing_core_readiness(self):
        markdown_index = {
            "status": "ok",
            "current_chunk_strategy_version": db.CHUNK_STRATEGY_VERSION,
            "indexed_file_count": 1,
            "stale_file_count": 0,
            "stale_chunk_count": 0,
            "reindex_required": False,
        }
        with (
            patch.object(settings, "redis_cache_enabled", True),
            patch.object(settings, "rag_readiness_timeout_ms", 1000),
            patch.object(main, "check_database_ready"),
            patch.object(main, "get_markdown_index_status", return_value=markdown_index),
            patch.object(main, "check_vector_store_ready", return_value=True),
            patch.object(main, "check_keyword_store_ready", return_value=True),
            patch.object(main, "check_graph_store_ready", return_value=True),
            patch.object(main, "check_cache_redis_ready", side_effect=ConnectionError("unavailable")),
        ):
            response = main.ready_health_check()

        self.assertEqual(response["status"], "ready")
        self.assertEqual(response["checks"]["cache_redis"], "error")
        self.assertEqual(
            response["capabilities"]["features"]["retrieval_cache"]["mode"],
            "postgres_l2_only",
        )


if __name__ == "__main__":
    unittest.main()

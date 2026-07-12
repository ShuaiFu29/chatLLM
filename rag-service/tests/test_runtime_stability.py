import os
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def base_env():
    keys = ["PATH", "SystemRoot", "ComSpec", "PATHEXT"]
    env = {key: os.environ[key] for key in keys if key in os.environ}
    env["PYTHONPATH"] = str(ROOT)
    return env


def import_config_expression(overrides, expression):
    env = base_env()
    env.update(overrides)
    return subprocess.run(
        [sys.executable, "-c", f"import config; print({expression})"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def run_main_script(overrides, script):
    env = base_env()
    env.update(overrides)
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def valid_env(extra=None):
    env = {
        "DATABASE_URL": "postgres://chatllm:chatllm@localhost:5432/chatllm",
        "S3_ENDPOINT": "http://localhost:9000",
        "S3_ACCESS_KEY": "minioadmin",
        "S3_SECRET_KEY": "minioadmin",
        "MILVUS_URI": "http://localhost:19530",
        "MILVUS_COLLECTION": "document_chunks",
        "ELASTICSEARCH_URL": "http://localhost:9200",
        "ELASTICSEARCH_INDEX": "chatllm_chunks",
        "NEO4J_URL": "http://localhost:7474",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "chatllm-password",
        "EMBEDDING_API_KEY": "embedding-key",
        "EMBEDDING_BASE_URL": "https://llm-ro9cl3th56gnvkzo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        "EMBEDDING_MODEL": "text-embedding-v4",
        "EMBEDDING_DIMENSION": "1024",
        "RAG_SERVICE_TOKEN": "test-rag-service-token-at-least-32-characters",
    }
    if extra:
        env.update(extra)
    return env


class RuntimeStabilityTests(unittest.TestCase):
    def test_config_exposes_readiness_and_ingest_concurrency_knobs(self):
        result = import_config_expression(
            valid_env({
                "RAG_READINESS_TIMEOUT_MS": "1500",
                "RAG_INGEST_CONCURRENCY": "3",
                "RAG_INGEST_STREAMING_THRESHOLD_BYTES": "2048",
                "RAG_INGEST_CHUNK_BATCH_SIZE": "25",
                "RAG_INGEST_EMBEDDING_BATCH_SIZE": "5",
                "ELASTICSEARCH_TIMEOUT_MS": "900",
                "ELASTICSEARCH_NUMBER_OF_SHARDS": "2",
                "ELASTICSEARCH_NUMBER_OF_REPLICAS": "1",
                "ELASTICSEARCH_BULK_BATCH_SIZE": "250",
                "ELASTICSEARCH_REFRESH_ON_WRITE": "true",
                "MILVUS_INDEX_TYPE": "HNSW",
                "MILVUS_METRIC_TYPE": "COSINE",
                "MILVUS_HNSW_M": "32",
                "MILVUS_HNSW_EF_CONSTRUCTION": "300",
                "MILVUS_SEARCH_EF": "128",
                "MILVUS_INSERT_BATCH_SIZE": "500",
                "NEO4J_TIMEOUT_MS": "1200",
                "NEO4J_BATCH_SIZE": "300",
                "RAG_ALLOWED_ORIGINS": "http://localhost:3000, http://localhost:5173",
            }),
            "(config.settings.rag_readiness_timeout_ms, config.settings.rag_ingest_concurrency, config.settings.rag_ingest_streaming_threshold_bytes, config.settings.rag_ingest_chunk_batch_size, config.settings.rag_ingest_embedding_batch_size, config.settings.elasticsearch_url, config.settings.elasticsearch_index, config.settings.elasticsearch_timeout_ms, config.settings.elasticsearch_number_of_shards, config.settings.elasticsearch_number_of_replicas, config.settings.elasticsearch_bulk_batch_size, config.settings.elasticsearch_refresh_on_write, config.settings.milvus_index_type, config.settings.milvus_metric_type, config.settings.milvus_hnsw_m, config.settings.milvus_hnsw_ef_construction, config.settings.milvus_search_ef, config.settings.milvus_insert_batch_size, config.settings.neo4j_url, config.settings.neo4j_user, config.settings.neo4j_timeout_ms, config.settings.neo4j_batch_size, config.settings.rag_allowed_origins)",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("(1500, 3, 2048, 25, 5, 'http://localhost:9200', 'chatllm_chunks', 900, 2, 1, 250, True, 'HNSW', 'COSINE', 32, 300, 128, 500, 'http://localhost:7474', 'neo4j', 1200, 300, ['http://localhost:3000', 'http://localhost:5173'])", result.stdout)

    def test_main_defines_ready_probe_and_ingest_concurrency_guard(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn('@app.get("/health/ready")', source)
        self.assertIn("check_database_ready", source)
        self.assertIn("check_vector_store_ready", source)
        self.assertIn("check_keyword_store_ready", source)
        self.assertIn("check_graph_store_ready", source)
        self.assertIn("threading.BoundedSemaphore", source)
        self.assertIn("settings.rag_ingest_concurrency", source)
        self.assertIn("settings.rag_allowed_origins", source)
        self.assertNotIn('allow_origins=["*"]', source)
        self.assertIn("ingest_semaphore.acquire(blocking=False)", source)
        self.assertIn("status_code=429", source)
        self.assertIn("process_file_with_guard", source)
        self.assertIn("require_internal_auth", source)
        self.assertIn('Header(alias="X-ChatLLM-RAG-Token")', source)
        self.assertIn("Depends(require_internal_auth)", source)

    def test_internal_auth_dependency_rejects_missing_or_wrong_tokens_even_if_runtime_setting_is_blank(self):
        script = """
from fastapi import HTTPException
import main

for expected in ("", "expected-rag-service-token-at-least-32-characters"):
    main.settings.rag_service_token = expected
    for token in (None, "", "wrong"):
        try:
            main.require_internal_auth(token)
        except HTTPException as error:
            assert error.status_code == 401
        else:
            raise SystemExit(f"accepted invalid token with expected={expected!r}")

main.settings.rag_service_token = "expected-rag-service-token-at-least-32-characters"
assert main.require_internal_auth("expected-rag-service-token-at-least-32-characters") is True
print("ok")
"""
        result = run_main_script(valid_env({"RAG_SERVICE_TOKEN": "expected-rag-service-token-at-least-32-characters"}), script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_internal_auth_uses_constant_time_token_comparison(self):
        script = """
import hmac
from unittest.mock import patch
import main

expected = "expected-rag-service-token-at-least-32-characters"
main.settings.rag_service_token = expected
original_compare = hmac.compare_digest

with patch("hmac.compare_digest", wraps=original_compare) as compare_digest:
    assert main.require_internal_auth(expected) is True
    compare_digest.assert_called_once_with(expected, expected)

print("ok")
"""
        result = run_main_script(valid_env(), script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_startup_does_not_crash_when_optional_indexes_are_temporarily_unavailable(self):
        script = """
from unittest.mock import patch
import main

with patch("main.ensure_collection"), patch("main.ensure_keyword_index", side_effect=RuntimeError("es warming up")), patch("main.ensure_graph_schema"):
    main.startup()

print("ok")
"""
        result = run_main_script(valid_env(), script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_retrieve_request_rejects_unbounded_inputs(self):
        script = """
from pydantic import ValidationError
from main import RetrieveRequest

invalid_payloads = [
    {"query": "", "user_id": "user-1"},
    {"query": "   ", "user_id": "user-1"},
    {"query": "hello", "user_id": ""},
    {"query": "hello", "user_id": "   "},
    {"query": "hello", "user_id": "user-1", "limit": 51},
    {"query": "hello", "user_id": "user-1", "limit": 0},
    {"query": "hello", "user_id": "user-1", "threshold": -0.01},
    {"query": "hello", "user_id": "user-1", "threshold": 1.01},
]

for payload in invalid_payloads:
    try:
        RetrieveRequest(**payload)
    except ValidationError:
        continue
    raise SystemExit(f"accepted invalid payload: {payload}")

valid = RetrieveRequest(query="hello", user_id="user-1", limit=10, threshold=0.5)
assert valid.query == "hello"
assert valid.limit == 10
assert valid.threshold == 0.5
print("ok")
"""
        result = run_main_script(valid_env(), script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_file_id_requests_reject_blank_and_unbounded_ids(self):
        script = """
from pydantic import ValidationError
from main import CleanupFileRequest, IngestRequest

for model in (IngestRequest, CleanupFileRequest):
    for file_id in ("", "   ", "x" * 129):
        try:
            model(file_id=file_id)
        except ValidationError:
            continue
        raise SystemExit(f"{model.__name__} accepted invalid file_id: {file_id!r}")

valid = IngestRequest(file_id="  file-123  ")
assert valid.file_id == "file-123"
print("ok")
"""
        result = run_main_script(valid_env(), script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_readiness_helpers_are_defined_for_database_and_vector_store(self):
        db_source = (ROOT / "db.py").read_text(encoding="utf-8")
        vector_source = (ROOT / "vector_store.py").read_text(encoding="utf-8")
        keyword_source = (ROOT / "keyword_store.py").read_text(encoding="utf-8")
        graph_source = (ROOT / "graph_store.py").read_text(encoding="utf-8")

        self.assertIn("def check_database_ready", db_source)
        self.assertIn("class _ConnectionPool", db_source)
        self.assertIn("settings.rag_db_pool_max", db_source)
        self.assertIn("settings.rag_db_pool_timeout_ms", db_source)
        self.assertIn("select 1", db_source.lower())
        self.assertIn("def check_vector_store_ready", vector_source)
        self.assertIn("client.has_collection", vector_source)
        self.assertIn("def check_keyword_store_ready", keyword_source)
        self.assertIn("settings.elasticsearch_index", keyword_source)
        self.assertIn("def check_graph_store_ready", graph_source)
        self.assertIn("settings.neo4j_url", graph_source)

    def test_database_connections_use_configured_connect_timeout(self):
        db_source = (ROOT / "db.py").read_text(encoding="utf-8")
        create_connection_body = db_source.split("def _create_connection", 1)[1].split("def acquire", 1)[0]

        self.assertIn("connect_timeout", create_connection_body)
        self.assertIn("settings.rag_db_pool_timeout_ms", create_connection_body)

    def test_database_readiness_checks_rag_cache_schema_before_accepting_ingestion(self):
        db_source = (ROOT / "db.py").read_text(encoding="utf-8")
        ready_body = db_source.split("def check_database_ready", 1)[1].split("def _index_settings_fingerprint", 1)[0]

        self.assertIn("project_spaces", ready_body)
        self.assertIn("knowledge_version", ready_body)
        self.assertIn("rag_index_versions", ready_body)
        self.assertIn("rag_retrieval_cache", ready_body)

    def test_cleanup_endpoint_removes_vector_and_keyword_indexes(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("delete_file_vectors", source)
        self.assertIn("delete_file_keywords", source)
        self.assertIn("delete_file_graph", source)

    def test_vector_store_escapes_filter_values_before_interpolation(self):
        vector_source = (ROOT / "vector_store.py").read_text(encoding="utf-8")

        self.assertIn("def _escape_filter_value", vector_source)
        self.assertIn(".replace", vector_source)
        self.assertIn("_escape_filter_value(file_id)", vector_source)
        self.assertIn("_escape_filter_value(user_id)", vector_source)
        self.assertIn("_escape_filter_value(project_space_id)", vector_source)

    def test_vector_and_keyword_stores_batch_large_ingestion_writes(self):
        vector_source = (ROOT / "vector_store.py").read_text(encoding="utf-8")
        keyword_source = (ROOT / "keyword_store.py").read_text(encoding="utf-8")
        graph_source = (ROOT / "graph_store.py").read_text(encoding="utf-8")

        self.assertIn("settings.milvus_insert_batch_size", vector_source)
        self.assertIn("settings.milvus_hnsw_m", vector_source)
        self.assertIn("settings.milvus_search_ef", vector_source)
        self.assertIn("_batched(rows, settings.milvus_insert_batch_size)", vector_source)
        self.assertIn("settings.elasticsearch_bulk_batch_size", keyword_source)
        self.assertIn("settings.elasticsearch_number_of_shards", keyword_source)
        self.assertIn("settings.elasticsearch_refresh_on_write", keyword_source)
        self.assertIn("_batched(rows, settings.elasticsearch_bulk_batch_size)", keyword_source)
        self.assertIn("settings.neo4j_batch_size", graph_source)

    def test_keyword_store_raises_on_elasticsearch_bulk_item_failures(self):
        script = """
from keyword_store import _raise_for_bulk_errors

_raise_for_bulk_errors({"errors": False})
try:
    _raise_for_bulk_errors({
        "errors": True,
        "items": [
            {"index": {"_id": "chunk-1", "error": {"type": "mapper_parsing_exception", "reason": "bad field"}}}
        ],
    })
except RuntimeError as error:
    assert "chunk-1" in str(error)
    assert "mapper_parsing_exception" in str(error)
else:
    raise SystemExit("bulk errors were ignored")
print("ok")
"""
        result = run_main_script(valid_env(), script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_keyword_delete_refreshes_index_before_followup_searches(self):
        script = """
from unittest.mock import patch
import keyword_store

paths = []

def fake_request(method, path, body=None):
    paths.append((method, path, body))
    return {}

with patch("keyword_store._request", fake_request):
    keyword_store.delete_file_keywords("file-1")

assert paths == [("POST", "chatllm_chunks/_delete_by_query?refresh=true", {"query": {"term": {"file_id": "file-1"}}})]
print("ok")
"""
        result = run_main_script(valid_env(), script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_vector_store_validates_existing_collection_schema(self):
        script = """
from vector_store import _validate_collection_schema

valid_description = {
    "fields": [
        {"name": "chunk_id"},
        {"name": "file_id"},
        {"name": "user_id"},
        {"name": "project_space_id"},
        {"name": "embedding", "params": {"dim": "1024"}},
    ]
}
_validate_collection_schema(valid_description)

for description in (
    {"fields": [{"name": "embedding", "params": {"dim": "768"}}]},
    {"fields": [{"name": "embedding", "params": {"dim": "1024"}}]},
):
    try:
        _validate_collection_schema(description)
    except RuntimeError:
        continue
    raise SystemExit("accepted invalid collection schema")
print("ok")
"""
        result = run_main_script(valid_env(), script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_vector_store_readiness_validates_existing_collection_schema(self):
        script = """
from unittest.mock import patch
import vector_store

invalid_description = {
    "fields": [
        {"name": "chunk_id"},
        {"name": "file_id"},
        {"name": "user_id"},
        {"name": "embedding", "params": {"dim": "1024"}},
    ]
}

class FakeClient:
    def has_collection(self, name):
        return True

    def describe_collection(self, collection_name):
        return invalid_description

with patch("vector_store.get_client", return_value=FakeClient()):
    try:
        vector_store.check_vector_store_ready()
    except RuntimeError as error:
        assert "project_space_id" in str(error)
    else:
        raise SystemExit("readiness accepted invalid Milvus schema")

print("ok")
"""
        result = run_main_script(valid_env(), script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)


if __name__ == "__main__":
    unittest.main()

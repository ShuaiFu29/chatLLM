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
                "ELASTICSEARCH_TIMEOUT_MS": "900",
                "NEO4J_TIMEOUT_MS": "1200",
                "RAG_ALLOWED_ORIGINS": "http://localhost:3000, http://localhost:5173",
            }),
            "(config.settings.rag_readiness_timeout_ms, config.settings.rag_ingest_concurrency, config.settings.elasticsearch_url, config.settings.elasticsearch_index, config.settings.elasticsearch_timeout_ms, config.settings.neo4j_url, config.settings.neo4j_user, config.settings.neo4j_timeout_ms, config.settings.rag_allowed_origins)",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("(1500, 3, 'http://localhost:9200', 'chatllm_chunks', 900, 'http://localhost:7474', 'neo4j', 1200, ['http://localhost:3000', 'http://localhost:5173'])", result.stdout)

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
        self.assertIn("select 1", db_source.lower())
        self.assertIn("def check_vector_store_ready", vector_source)
        self.assertIn("client.has_collection", vector_source)
        self.assertIn("def check_keyword_store_ready", keyword_source)
        self.assertIn("settings.elasticsearch_index", keyword_source)
        self.assertIn("def check_graph_store_ready", graph_source)
        self.assertIn("settings.neo4j_url", graph_source)

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


if __name__ == "__main__":
    unittest.main()

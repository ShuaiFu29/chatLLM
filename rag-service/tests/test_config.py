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


def import_config(overrides):
    env = base_env()
    env.update(overrides)
    return subprocess.run(
        [sys.executable, "-c", "import config; print(config.settings.database_url)"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


class ConfigTests(unittest.TestCase):
    def test_config_fails_fast_when_required_keys_are_missing(self):
        result = import_config({
            "DATABASE_URL": "",
            "S3_ENDPOINT": "",
            "S3_ACCESS_KEY": "",
            "S3_SECRET_KEY": "",
            "MILVUS_URI": "",
            "MILVUS_COLLECTION": "",
            "EMBEDDING_API_KEY": "",
            "EMBEDDING_BASE_URL": "",
            "EMBEDDING_MODEL": "",
            "EMBEDDING_DIMENSION": "",
        })

        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(
            result.stderr,
            r"Missing required RAG environment variables: DATABASE_URL, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, MILVUS_URI, MILVUS_COLLECTION, EMBEDDING_API_KEY, EMBEDDING_BASE_URL, EMBEDDING_MODEL, EMBEDDING_DIMENSION",
        )

    def test_config_rejects_invalid_embedding_dimension(self):
        result = import_config({
            "DATABASE_URL": "postgres://chatllm:chatllm@localhost:5432/chatllm",
            "S3_ENDPOINT": "http://localhost:9000",
            "S3_ACCESS_KEY": "minioadmin",
            "S3_SECRET_KEY": "minioadmin",
            "MILVUS_URI": "http://localhost:19530",
            "MILVUS_COLLECTION": "document_chunks",
            "EMBEDDING_API_KEY": "embedding-key",
            "EMBEDDING_BASE_URL": "https://llm-ro9cl3th56gnvkzo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
            "EMBEDDING_MODEL": "text-embedding-v4",
            "EMBEDDING_DIMENSION": "zero",
        })

        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr, r"EMBEDDING_DIMENSION must be a positive integer")

    def test_config_loads_valid_values(self):
        result = import_config({
            "DATABASE_URL": "postgres://chatllm:chatllm@localhost:5432/chatllm",
            "S3_ENDPOINT": "http://localhost:9000",
            "S3_ACCESS_KEY": "minioadmin",
            "S3_SECRET_KEY": "minioadmin",
            "MILVUS_URI": "http://localhost:19530",
            "MILVUS_COLLECTION": "document_chunks",
            "EMBEDDING_API_KEY": "embedding-key",
            "EMBEDDING_BASE_URL": "https://llm-ro9cl3th56gnvkzo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
            "EMBEDDING_MODEL": "text-embedding-v4",
            "EMBEDDING_DIMENSION": "1024",
        })

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("postgres://chatllm:chatllm@localhost:5432/chatllm", result.stdout)

    def test_config_exposes_internal_auth_and_database_pool_knobs(self):
        env = {
            "DATABASE_URL": "postgres://chatllm:chatllm@localhost:5432/chatllm",
            "S3_ENDPOINT": "http://localhost:9000",
            "S3_ACCESS_KEY": "minioadmin",
            "S3_SECRET_KEY": "minioadmin",
            "MILVUS_URI": "http://localhost:19530",
            "MILVUS_COLLECTION": "document_chunks",
            "EMBEDDING_API_KEY": "embedding-key",
            "EMBEDDING_BASE_URL": "https://llm-ro9cl3th56gnvkzo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
            "EMBEDDING_MODEL": "text-embedding-v4",
            "EMBEDDING_DIMENSION": "1024",
            "RAG_SERVICE_TOKEN": "internal-token",
            "RAG_DB_POOL_MAX": "9",
            "RAG_DB_POOL_TIMEOUT_MS": "1200",
        }
        runtime = base_env()
        runtime.update(env)
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import config; print((config.settings.rag_service_token, config.settings.rag_db_pool_max, config.settings.rag_db_pool_timeout_ms))",
            ],
            cwd=ROOT,
            env=runtime,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("('internal-token', 9, 1200)", result.stdout)


if __name__ == "__main__":
    unittest.main()

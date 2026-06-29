import math
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


def local_env(extra=None):
    env = {
        "DATABASE_URL": "postgres://chatllm:chatllm@localhost:5432/chatllm",
        "S3_ENDPOINT": "http://localhost:9000",
        "S3_ACCESS_KEY": "minioadmin",
        "S3_SECRET_KEY": "minioadmin",
        "MILVUS_URI": "http://localhost:19530",
        "MILVUS_COLLECTION": "document_chunks_local_test",
        "EMBEDDING_PROVIDER": "local",
        "EMBEDDING_DIMENSION": "32",
    }
    if extra:
        env.update(extra)
    return env


def run_script(script, env):
    merged = base_env()
    merged.update(env)
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=ROOT,
        env=merged,
        text=True,
        capture_output=True,
        check=False,
    )


class LocalEmbeddingTests(unittest.TestCase):
    def test_local_provider_loads_without_external_embedding_credentials(self):
        result = run_script(
            "import config; print(config.settings.embedding_provider, config.settings.embedding_dimension, config.settings.embedding_model)",
            local_env(),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("local 32 local-hash", result.stdout)

    def test_local_embeddings_are_deterministic_normalized_and_dimensioned(self):
        script = """
from embeddings import get_embedding, get_embeddings

first = get_embedding("Cobalt smoke marker marker")
second = get_embedding("Cobalt smoke marker marker")
batch = get_embeddings(["Cobalt smoke marker marker", "different text"])

assert first == second
assert first == batch[0]
assert len(first) == 32
assert len(batch[1]) == 32
norm = sum(value * value for value in first) ** 0.5
assert 0.999 <= norm <= 1.001, norm
assert first != batch[1]
print("ok")
"""
        result = run_script(script, local_env())

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_remote_embeddings_are_split_into_provider_safe_batches(self):
        script = """
from types import SimpleNamespace
import embeddings

calls = []

class FakeEmbeddings:
    def create(self, input, model):
        calls.append(list(input))
        return SimpleNamespace(data=[
            SimpleNamespace(embedding=[float(len(calls)), float(index)])
            for index, _ in enumerate(input)
        ])

class FakeClient:
    embeddings = FakeEmbeddings()

embeddings.client = FakeClient()
vectors = embeddings.get_embeddings([f"text {index}" for index in range(12)])

assert [len(call) for call in calls] == [10, 2], calls
assert len(vectors) == 12
print("ok")
"""
        result = run_script(script, local_env({
            "EMBEDDING_PROVIDER": "openai-compatible",
            "EMBEDDING_API_KEY": "embedding-key",
            "EMBEDDING_BASE_URL": "https://example.test/compatible-mode/v1",
            "EMBEDDING_MODEL": "text-embedding-v4",
            "EMBEDDING_DIMENSION": "1024",
        }))

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)


if __name__ == "__main__":
    unittest.main()

import os
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEST_TOKEN = "test-rag-service-token-at-least-32-characters"


def valid_env(extra=None):
    keys = ["PATH", "SystemRoot", "ComSpec", "PATHEXT"]
    env = {key: os.environ[key] for key in keys if key in os.environ}
    env.update({
        "PYTHONPATH": str(ROOT),
        "DATABASE_URL": "postgres://chatllm:chatllm@localhost:5432/chatllm",
        "S3_ENDPOINT": "http://localhost:9000",
        "S3_ACCESS_KEY": "test-access-key",
        "S3_SECRET_KEY": "test-secret-key",
        "MILVUS_URI": "http://localhost:19530",
        "MILVUS_COLLECTION": "document_chunks_http_safety_test",
        "EMBEDDING_PROVIDER": "local",
        "EMBEDDING_DIMENSION": "32",
        "RAG_SERVICE_TOKEN": TEST_TOKEN,
    })
    if extra:
        env.update(extra)
    return env


def run_script(script, extra_env=None):
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=ROOT,
        env=valid_env(extra_env),
        text=True,
        capture_output=True,
        check=False,
    )


class HttpSafetyTests(unittest.TestCase):
    def test_config_exposes_a_positive_request_body_limit(self):
        result = run_script(
            "import config; assert config.settings.rag_max_request_bytes == 1234; print('ok')",
            {"RAG_MAX_REQUEST_BYTES": "1234"},
        )

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_request_models_reject_unknown_fields_with_422(self):
        script = f"""
from unittest.mock import patch
from fastapi.testclient import TestClient
import main

client = TestClient(main.app, raise_server_exceptions=False)
with patch("main.retrieve_documents", return_value=[]):
    response = client.post(
        "/retrieve",
        headers={{"X-ChatLLM-RAG-Token": "{TEST_TOKEN}"}},
        json={{"query": "hello", "user_id": "user-1", "unexpected": True}},
    )

assert response.status_code == 422, response.text
print("ok")
"""
        result = run_script(script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_streamed_oversized_body_returns_413_before_endpoint_execution(self):
        script = """
import asyncio
from http_safety import RequestBodyLimitMiddleware

executed = False
sent = []
messages = iter([
    {"type": "http.request", "body": b"abc", "more_body": True},
    {"type": "http.request", "body": b"def", "more_body": False},
])

async def endpoint(scope, receive, send):
    global executed
    executed = True
    await send({"type": "http.response.start", "status": 204, "headers": []})
    await send({"type": "http.response.body", "body": b""})

async def receive():
    return next(messages)

async def send(message):
    sent.append(message)

scope = {"type": "http", "method": "POST", "headers": []}
asyncio.run(RequestBodyLimitMiddleware(endpoint, max_body_bytes=5)(scope, receive, send))

assert executed is False
assert sent[0]["type"] == "http.response.start"
assert sent[0]["status"] == 413
assert b"request_too_large" in sent[1]["body"]
print("ok")
"""
        result = run_script(script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_declared_oversized_body_returns_413_without_reading_the_stream(self):
        script = """
import asyncio
from http_safety import RequestBodyLimitMiddleware

executed = False
receive_calls = 0
sent = []

async def endpoint(scope, receive, send):
    global executed
    executed = True

async def receive():
    global receive_calls
    receive_calls += 1
    return {"type": "http.request", "body": b"ignored", "more_body": False}

async def send(message):
    sent.append(message)

scope = {"type": "http", "method": "POST", "headers": [(b"content-length", b"6")]}
asyncio.run(RequestBodyLimitMiddleware(endpoint, max_body_bytes=5)(scope, receive, send))

assert executed is False
assert receive_calls == 0
assert sent[0]["status"] == 413
print("ok")
"""
        result = run_script(script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_main_app_applies_the_configured_request_body_limit(self):
        script = f"""
from unittest.mock import patch
from fastapi.testclient import TestClient
import main

client = TestClient(main.app, raise_server_exceptions=False)
with patch("main.retrieve_documents", return_value=[]):
    response = client.post(
        "/retrieve",
        headers={{"X-ChatLLM-RAG-Token": "{TEST_TOKEN}"}},
        json={{"query": "hello", "user_id": "user-1"}},
    )

assert response.status_code == 413, response.text
assert response.json()["detail"]["code"] == "request_too_large"
print("ok")
"""
        result = run_script(script, {"RAG_MAX_REQUEST_BYTES": "5"})

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_internal_errors_are_sanitized_and_include_a_request_id(self):
        secret_text = "injected-secret-exception-text"
        script = f"""
from unittest.mock import patch
from fastapi.testclient import TestClient
import main

client = TestClient(main.app, raise_server_exceptions=False)
with patch("main.retrieve_documents", side_effect=RuntimeError("{secret_text}")):
    response = client.post(
        "/retrieve",
        headers={{
            "X-ChatLLM-RAG-Token": "{TEST_TOKEN}",
            "X-Request-ID": "test-request-id-123",
        }},
        json={{"query": "hello", "user_id": "user-1"}},
    )

assert response.status_code == 500, response.text
assert "{secret_text}" not in response.text
assert response.json()["detail"] == {{
    "code": "internal_error",
    "request_id": "test-request-id-123",
}}
assert response.headers["X-Request-ID"] == "test-request-id-123"
print("ok")
"""
        result = run_script(script)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)


if __name__ == "__main__":
    unittest.main()

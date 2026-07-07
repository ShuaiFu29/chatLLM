import json
from types import SimpleNamespace
from typing import Any
from urllib import error, request


class CompatibleApiError(RuntimeError):
    def __init__(self, status_code: int, response_body: str):
        super().__init__(f"Compatible model API request failed with status {status_code}")
        self.status_code = status_code
        self.response_body = response_body


def post_json(base_url: str, api_key: str, path: str, payload: dict[str, Any], timeout: float = 60.0) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}{path}"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    req = request.Request(url, data=body, headers=headers, method="POST")

    try:
        with request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        raise CompatibleApiError(exc.code, response_body) from exc


class CompatibleEmbeddingClient:
    def __init__(self, api_key: str, base_url: str, timeout: float = 60.0):
        self.embeddings = _EmbeddingsEndpoint(api_key, base_url, timeout)


class _EmbeddingsEndpoint:
    def __init__(self, api_key: str, base_url: str, timeout: float):
        self.api_key = api_key
        self.base_url = base_url
        self.timeout = timeout

    def create(self, input: list[str], model: str):
        response = post_json(
            self.base_url,
            self.api_key,
            "/embeddings",
            {"input": input, "model": model},
            self.timeout,
        )
        return SimpleNamespace(
            data=[
                SimpleNamespace(embedding=item.get("embedding", []))
                for item in response.get("data", [])
            ]
        )

import json
from types import SimpleNamespace
from typing import Any
from urllib import error, request

from http_safety import validate_http_url


class CompatibleApiError(RuntimeError):
    def __init__(self, status_code: int, response_body: str):
        super().__init__(f"Compatible model API request failed with status {status_code}")
        self.status_code = status_code
        self.response_body = response_body


def post_json(base_url: str, api_key: str, path: str, payload: dict[str, Any], timeout: float = 60.0) -> dict[str, Any]:
    url = validate_http_url(f"{base_url.rstrip('/')}{path}", "Compatible API URL")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    req = request.Request(url, data=body, headers=headers, method="POST")

    try:
        # validate_http_url restricts the request to HTTP(S) before transport.
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with request.urlopen(req, timeout=timeout) as response:  # nosec B310
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
        response_data = response.get("data") if isinstance(response, dict) else None
        if not isinstance(response_data, list):
            return SimpleNamespace(data=response_data)
        return SimpleNamespace(
            data=[
                SimpleNamespace(
                    index=item.get("index") if isinstance(item, dict) else None,
                    embedding=item.get("embedding") if isinstance(item, dict) else None,
                )
                for item in response_data
            ]
        )

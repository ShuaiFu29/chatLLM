import json
import urllib.error
import urllib.request

from config import settings


def _batched(rows: list[dict], batch_size: int):
    for index in range(0, len(rows), batch_size):
        yield rows[index: index + batch_size]


def _request(method: str, path: str, body: dict | str | None = None) -> dict:
    if not settings.elasticsearch_enabled:
        return {}

    data: bytes | None = None
    headers = {"Content-Type": "application/json"}
    if body is not None:
        if isinstance(body, str):
            data = body.encode("utf-8")
            headers = {"Content-Type": "application/x-ndjson"}
        else:
            data = json.dumps(body).encode("utf-8")

    request = urllib.request.Request(
        f"{settings.elasticsearch_url.rstrip('/')}/{path.lstrip('/')}",
        data=data,
        headers=headers,
        method=method,
    )
    timeout_seconds = settings.elasticsearch_timeout_ms / 1000
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def _raise_for_bulk_errors(response: dict):
    if not response.get("errors"):
        return

    failures = []
    for item in response.get("items", [])[:5]:
        action = next(iter(item.values()), {})
        error = action.get("error")
        if not error:
            continue
        chunk_id = action.get("_id", "unknown")
        error_type = error.get("type", "unknown_error") if isinstance(error, dict) else "unknown_error"
        reason = error.get("reason", "") if isinstance(error, dict) else str(error)
        failures.append(f"{chunk_id}: {error_type} {reason}".strip())

    detail = "; ".join(failures) or "unknown bulk indexing error"
    raise RuntimeError(f"Elasticsearch bulk indexing failed: {detail}")


def check_keyword_store_ready() -> bool:
    if not settings.elasticsearch_enabled:
        return True
    _request("GET", "/")
    return True


def ensure_keyword_index():
    if not settings.elasticsearch_enabled:
        return

    mapping = {
        "settings": {
            "number_of_shards": settings.elasticsearch_number_of_shards,
            "number_of_replicas": settings.elasticsearch_number_of_replicas,
            "analysis": {
                "analyzer": {
                    "chatllm_mixed_text": {
                        "type": "standard",
                    },
                },
            },
        },
        "mappings": {
            "properties": {
                "chunk_id": {"type": "keyword"},
                "file_id": {"type": "keyword"},
                "user_id": {"type": "keyword"},
                "project_space_id": {"type": "keyword"},
                "filename": {"type": "keyword"},
                "chunk_index": {"type": "integer"},
                "content": {"type": "text", "analyzer": "chatllm_mixed_text"},
            },
        },
    }

    try:
        _request("PUT", settings.elasticsearch_index, mapping)
    except urllib.error.HTTPError as error:
        if error.code != 400:
            raise


def index_chunks(rows: list[dict]):
    if not rows or not settings.elasticsearch_enabled:
        return

    ensure_keyword_index()
    bulk_path = "/_bulk?refresh=true" if settings.elasticsearch_refresh_on_write else "/_bulk"

    for batch in _batched(rows, settings.elasticsearch_bulk_batch_size):
        lines = []
        for row in batch:
            metadata = row.get("metadata") or {}
            chunk_id = str(row.get("id") or row.get("chunk_id"))
            lines.append(json.dumps({
                "index": {
                    "_index": settings.elasticsearch_index,
                    "_id": chunk_id,
                },
            }))
            lines.append(json.dumps({
                "chunk_id": chunk_id,
                "file_id": str(row.get("file_id") or metadata.get("file_id") or ""),
                "user_id": str(row.get("user_id") or metadata.get("user_id") or ""),
                "project_space_id": str(metadata.get("project_space_id") or ""),
                "filename": metadata.get("filename") or "",
                "chunk_index": int(row.get("chunk_index") or metadata.get("chunk_index") or 0),
                "content": row.get("content") or "",
            }, ensure_ascii=False))

        payload = "\n".join(lines) + "\n"
        response = _request("POST", bulk_path, payload)
        _raise_for_bulk_errors(response)


def delete_file_keywords(file_id: str):
    if not settings.elasticsearch_enabled:
        return

    try:
        _request("POST", f"{settings.elasticsearch_index}/_delete_by_query", {
            "query": {"term": {"file_id": file_id}},
        })
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise


def search_keyword_chunks(
    query: str,
    user_id: str,
    project_space_id: str | None = None,
    limit: int = 20,
) -> list[dict]:
    if not query.strip() or not settings.elasticsearch_enabled:
        return []

    filters: list[dict] = [{"term": {"user_id": user_id}}]
    if project_space_id:
        filters.append({"term": {"project_space_id": project_space_id}})

    body = {
        "size": limit,
        "query": {
            "bool": {
                "must": [{"match": {"content": query}}],
                "filter": filters,
            },
        },
    }

    try:
        response = _request("POST", f"{settings.elasticsearch_index}/_search", body)
    except Exception:
        return []

    hits = response.get("hits", {}).get("hits", [])
    results = []
    for hit in hits:
        source = hit.get("_source") or {}
        results.append({
            "id": str(source.get("chunk_id") or hit.get("_id")),
            "file_id": source.get("file_id"),
            "user_id": source.get("user_id"),
            "chunk_index": source.get("chunk_index"),
            "content": source.get("content") or "",
            "metadata": {
                "filename": source.get("filename"),
                "file_id": source.get("file_id"),
                "chunk_index": source.get("chunk_index"),
                "project_space_id": source.get("project_space_id") or None,
            },
            "project_space_id": source.get("project_space_id") or None,
            "filename": source.get("filename"),
            "lexical_score": float(hit.get("_score") or 0),
        })

    return results

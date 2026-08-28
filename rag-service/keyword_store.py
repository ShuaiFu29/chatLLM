import json
import urllib.error
import urllib.request

from config import settings
from http_safety import validate_http_url


class KeywordStoreUnavailableError(RuntimeError):
    """Raised when Elasticsearch cannot execute a configured keyword search."""


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

    url = validate_http_url(
        f"{settings.elasticsearch_url.rstrip('/')}/{path.lstrip('/')}",
        "ELASTICSEARCH_URL",
    )
    request = urllib.request.Request(
        url,
        data=data,
        headers=headers,
        method=method,
    )
    timeout_seconds = settings.elasticsearch_timeout_ms / 1000
    # validate_http_url restricts the request to HTTP(S) before transport.
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:  # nosec B310
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
                    # Despite the name, this is Elasticsearch's stock `standard`
                    # analyzer and performs no Chinese word segmentation: it
                    # splits CJK text per character. Mixed-script coverage comes
                    # from the `.cjk` sub-fields declared below, which apply the
                    # built-in `cjk` analyzer (bigrams), not from this entry.
                    #
                    # Real segmentation needs an IK or ICU plugin installed on
                    # the cluster, which is an infrastructure change and a
                    # reindex, so it is tracked as a task rather than faked here.
                    # The misleading name is kept deliberately: it is part of the
                    # index settings, and renaming it would change the mapping and
                    # force a full BM25 rebuild for every existing deployment.
                    "chatllm_mixed_text": {
                        "type": "standard",
                    },
                },
            },
        },
        "mappings": {
            "_meta": {
                "chatllm_schema_version": settings.elasticsearch_schema_version,
            },
            "properties": {
                "chunk_id": {"type": "keyword"},
                "file_id": {"type": "keyword"},
                "user_id": {"type": "keyword"},
                "project_space_id": {"type": "keyword"},
                "filename": {
                    "type": "text",
                    "analyzer": "chatllm_mixed_text",
                    "fields": {
                        "keyword": {"type": "keyword"},
                        "cjk": {"type": "text", "analyzer": "cjk"},
                    },
                },
                "heading": {
                    "type": "text",
                    "analyzer": "chatllm_mixed_text",
                    "fields": {"cjk": {"type": "text", "analyzer": "cjk"}},
                },
                "chunk_index": {"type": "integer"},
                "content": {
                    "type": "text",
                    "analyzer": "chatllm_mixed_text",
                    "fields": {"cjk": {"type": "text", "analyzer": "cjk"}},
                },
            },
        },
    }

    try:
        _request("PUT", settings.elasticsearch_index, mapping)
    except urllib.error.HTTPError as error:
        if error.code != 400:
            raise
        current = _request("GET", f"{settings.elasticsearch_index}/_mapping")
        current_meta = ((current.get(settings.elasticsearch_index) or {}).get("mappings") or {}).get("_meta") or {}
        if current_meta.get("chatllm_schema_version") != settings.elasticsearch_schema_version:
            raise RuntimeError(
                "Elasticsearch index schema is incompatible; configure a new ELASTICSEARCH_INDEX and reindex Markdown files"
            ) from error


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
                "heading": " / ".join(str(item) for item in (metadata.get("heading_path") or []) if str(item).strip()),
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
        _request("POST", f"{settings.elasticsearch_index}/_delete_by_query?refresh=true", {
            "query": {"term": {"file_id": file_id}},
        })
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise


def delete_chunk_keywords(chunk_ids: list[str]):
    if not settings.elasticsearch_enabled:
        return

    normalized_ids = list(
        dict.fromkeys(
            str(chunk_id).strip()
            for chunk_id in chunk_ids
            if str(chunk_id).strip()
        )
    )
    for batch in _batched(normalized_ids, settings.elasticsearch_bulk_batch_size):
        try:
            _request(
                "POST",
                f"{settings.elasticsearch_index}/_delete_by_query?refresh=true",
                {"query": {"terms": {"chunk_id": batch}}},
            )
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
        "_source": False,
        "query": {
            "bool": {
                "must": [{
                    "multi_match": {
                        "query": query,
                        "type": "best_fields",
                        "fields": [
                            "filename^4",
                            "filename.cjk^3",
                            "heading^2.5",
                            "heading.cjk^2",
                            "content",
                            "content.cjk",
                        ],
                    },
                }],
                "filter": filters,
            },
        },
    }

    try:
        response = _request("POST", f"{settings.elasticsearch_index}/_search", body)
    except Exception as error:
        raise KeywordStoreUnavailableError("Elasticsearch keyword search failed") from error

    hits = response.get("hits", {}).get("hits", [])
    results = []
    for hit in hits:
        chunk_id = hit.get("_id")
        if chunk_id:
            results.append({
                "chunk_id": str(chunk_id),
                "lexical_score": float(hit.get("_score") or 0),
            })

    return results

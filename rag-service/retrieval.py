from concurrent.futures import ThreadPoolExecutor, as_completed

from db import get_active_chunks_by_ids, search_chunks_by_text
from embeddings import get_embedding
from fusion import reciprocal_rank_fuse
from graph_store import search_graph
from keyword_store import KeywordStoreUnavailableError, search_keyword_chunks
from vector_store import search_vectors

RETRIEVAL_CHANNEL_ORDER = ("vector", "bm25", "graph")
DEFAULT_RETRIEVAL_ROUTES = ("vector", "bm25")
RETRIEVAL_CHANNEL_WEIGHTS = {"vector": 1.0, "bm25": 1.0, "graph": 0.7}


class RetrievalChannelsUnavailableError(RuntimeError):
    pass


class RetrievalDocuments(list):
    """List-compatible retrieval result with non-sensitive lane health metadata."""

    def __init__(self, documents: list[dict], channel_status: dict[str, str]):
        super().__init__(documents)
        self.channel_status = dict(channel_status)
        self.degraded = any(status in {"degraded", "error"} for status in channel_status.values())


class KeywordDocuments(list):
    """Keyword results that retain whether PostgreSQL replaced a failed ES query."""

    def __init__(self, documents: list[dict], backend_degraded: bool = False):
        super().__init__(documents)
        self.backend_degraded = backend_degraded


def _explicit_or_metadata(document: dict, metadata: dict, field: str, default):
    if field in document:
        return document.get(field)
    return metadata.get(field, default)


def _authoritative_chunk(chunk: dict) -> dict:
    document = dict(chunk)
    metadata = dict(document.get("metadata") or {})
    project_space_id = document.get("project_space_id")
    conversion_generation_id = _explicit_or_metadata(
        document, metadata, "conversion_generation_id", None,
    )
    source_unit_ids = _explicit_or_metadata(document, metadata, "source_unit_ids", []) or []
    source_locator = _explicit_or_metadata(document, metadata, "source_locator", {}) or {}
    metadata.update({
        "filename": document.get("filename") or metadata.get("filename"),
        "file_id": str(document.get("file_id") or metadata.get("file_id") or ""),
        "chunk_index": document.get("chunk_index"),
        "project_space_id": str(project_space_id) if project_space_id else None,
        "document_kind": document.get("document_kind") or metadata.get("document_kind") or "markdown",
        "conversion_generation_id": (
            str(conversion_generation_id) if conversion_generation_id else None
        ),
        "source_unit_ids": [str(value) for value in source_unit_ids],
        "source_locator": dict(source_locator),
    })
    document["metadata"] = metadata
    return document


def _candidate_chunk_id(hit: dict) -> str:
    return str(hit.get("chunk_id") or hit.get("id") or "").strip()


def _hydrate_scored_hits(
    hits: list[dict],
    user_id: str,
    project_space_id: str | None,
    score_field: str,
) -> list[dict]:
    candidate_ids = [_candidate_chunk_id(hit) for hit in hits]
    chunks = get_active_chunks_by_ids(candidate_ids, user_id, project_space_id)
    chunks_by_id = {
        str(chunk["id"]): _authoritative_chunk(chunk)
        for chunk in chunks
    }
    documents = []
    emitted_ids: set[str] = set()
    for hit in hits:
        chunk_id = _candidate_chunk_id(hit)
        if not chunk_id or chunk_id in emitted_ids:
            continue
        chunk = chunks_by_id.get(chunk_id)
        if not chunk:
            continue
        document = dict(chunk)
        document[score_field] = float(hit.get(score_field) or 0)
        documents.append(document)
        emitted_ids.add(chunk_id)
    return documents


def _prepare_chunk_result(
    chunk: dict,
    similarity: float,
    lexical_score: float,
    retrieval_score: float,
    retrieval_mode: str,
    rrf_score: float = 0.0,
    retrieval_channels: list[str] | None = None,
    channel_ranks: dict | None = None,
    channel_scores: dict | None = None,
):
    metadata = dict(chunk.get("metadata") or {})
    chunk_project_space_id = chunk.get("project_space_id")
    conversion_generation_id = _explicit_or_metadata(
        chunk, metadata, "conversion_generation_id", None,
    )
    source_unit_ids = _explicit_or_metadata(chunk, metadata, "source_unit_ids", []) or []
    source_locator = _explicit_or_metadata(chunk, metadata, "source_locator", {}) or {}
    metadata.update({
        "filename": chunk.get("filename") or metadata.get("filename"),
        "file_id": str(chunk.get("file_id") or metadata.get("file_id") or ""),
        "chunk_index": chunk.get("chunk_index"),
        "project_space_id": str(chunk_project_space_id) if chunk_project_space_id else None,
        "retrieval_mode": retrieval_mode,
        "vector_similarity": similarity,
        "lexical_score": lexical_score,
        "rrf_score": rrf_score,
        "retrieval_channels": retrieval_channels or [],
        "channel_ranks": channel_ranks or {},
        "channel_scores": channel_scores or {},
        "document_kind": chunk.get("document_kind") or metadata.get("document_kind") or "markdown",
        "conversion_generation_id": (
            str(conversion_generation_id) if conversion_generation_id else None
        ),
        "source_unit_ids": [str(value) for value in source_unit_ids],
        "source_locator": dict(source_locator),
    })

    result = {
        "id": str(chunk["id"]),
        "content": chunk["content"],
        "metadata": metadata,
        "similarity": retrieval_score,
        "vector_similarity": similarity,
        "lexical_score": lexical_score,
        "retrieval_score": retrieval_score,
        "rrf_score": rrf_score,
        "retrieval_channels": retrieval_channels or [],
        "channel_ranks": channel_ranks or {},
        "channel_scores": channel_scores or {},
    }
    if chunk.get("graph_score") is not None:
        try:
            result["graph_score"] = float(chunk["graph_score"])
        except (TypeError, ValueError):
            pass
    return result


def _vector_documents_from_hits(
    vector_hits: list[dict],
    user_id: str,
    project_space_id: str | None,
) -> list[dict]:
    documents = _hydrate_scored_hits(
        vector_hits,
        user_id,
        project_space_id,
        "similarity",
    )
    for document in documents:
        document["retrieval_score"] = document["similarity"]
    return documents


def _retrieve_vector_documents(
    query: str,
    user_id: str,
    project_space_id: str | None,
    limit: int,
    threshold: float,
) -> list[dict]:
    embedding = get_embedding(query)
    vector_hits = search_vectors(
        user_id=user_id,
        embedding=embedding,
        limit=limit,
        threshold=threshold,
        project_space_id=project_space_id,
    )
    return _vector_documents_from_hits(vector_hits, user_id, project_space_id)


def _keyword_documents(query: str, user_id: str, project_space_id: str | None, limit: int) -> list[dict]:
    backend_degraded = False
    try:
        keyword_hits = search_keyword_chunks(
            query=query,
            user_id=user_id,
            project_space_id=project_space_id,
            limit=limit,
        )
    except KeywordStoreUnavailableError:
        backend_degraded = True
        keyword_hits = []

    documents = _hydrate_scored_hits(
        keyword_hits,
        user_id,
        project_space_id,
        "lexical_score",
    ) if keyword_hits else []
    if not documents:
        if keyword_hits:
            backend_degraded = True
        documents = [
            _authoritative_chunk(hit)
            for hit in search_chunks_by_text(
                query=query,
                user_id=user_id,
                project_space_id=project_space_id,
                limit=limit,
            )
        ]

    max_lexical_score = max([float(document.get("lexical_score") or 0) for document in documents] or [0])
    for document in documents:
        lexical_score = float(document.get("lexical_score") or 0)
        document["similarity"] = 0.0
        document["retrieval_score"] = lexical_score / max_lexical_score if max_lexical_score > 0 else 0.0

    return KeywordDocuments(documents, backend_degraded=backend_degraded)


def _retrieve_graph_documents(
    query: str,
    user_id: str,
    project_space_id: str | None,
    limit: int,
) -> list[dict]:
    return search_graph(
        query=query,
        user_id=user_id,
        project_space_id=project_space_id,
        limit=limit,
    )


def _normalize_routes(routes: list[str] | tuple[str, ...] | None, hybrid: bool) -> tuple[str, ...]:
    requested = routes if routes is not None else (DEFAULT_RETRIEVAL_ROUTES if hybrid else ("vector",))
    requested_set = {str(route).strip().lower() for route in requested if str(route).strip()}
    unknown_routes = requested_set - set(RETRIEVAL_CHANNEL_ORDER)
    if unknown_routes:
        raise ValueError(f"Unsupported retrieval routes: {', '.join(sorted(unknown_routes))}")
    normalized = tuple(channel for channel in RETRIEVAL_CHANNEL_ORDER if channel in requested_set)
    if not normalized:
        raise ValueError("At least one retrieval route is required")
    return normalized


def _result_source_key(result: dict) -> str:
    metadata = result.get("metadata") or {}
    return str(metadata.get("file_id") or metadata.get("filename") or result.get("id") or "")


def _apply_source_diversity(results: list[dict], limit: int) -> list[dict]:
    if limit <= 0:
        return []
    if len(results) <= limit:
        for index, result in enumerate(results, start=1):
            result.setdefault("metadata", {})["source_diversity_rank"] = index
        return results

    max_per_source_first_pass = 2 if limit >= 4 else limit
    selected: list[dict] = []
    selected_ids: set[str] = set()
    source_counts: dict[str, int] = {}

    for result in results:
        source_key = _result_source_key(result)
        if source_counts.get(source_key, 0) >= max_per_source_first_pass:
            continue
        selected.append(result)
        selected_ids.add(str(result.get("id")))
        source_counts[source_key] = source_counts.get(source_key, 0) + 1
        if len(selected) >= limit:
            break

    if len(selected) < limit:
        for result in results:
            result_id = str(result.get("id"))
            if result_id in selected_ids:
                continue
            selected.append(result)
            selected_ids.add(result_id)
            if len(selected) >= limit:
                break

    for index, result in enumerate(selected, start=1):
        result.setdefault("metadata", {})["source_diversity_rank"] = index
        result["source_diversity_rank"] = index

    return selected


def retrieve_documents(
    query: str,
    user_id: str,
    project_space_id: str | None = None,
    limit: int = 5,
    threshold: float = 0.1,
    hybrid: bool = True,
    routes: list[str] | tuple[str, ...] | None = None,
):
    selected_routes = _normalize_routes(routes, hybrid)
    search_limit = min(max(limit * 5, limit), 50)
    keyword_limit = search_limit
    graph_limit = min(max(limit * 3, limit), 30)
    lane_calls = {
        "vector": lambda: _retrieve_vector_documents(
            query, user_id, project_space_id, search_limit, threshold,
        ),
        "bm25": lambda: _keyword_documents(
            query, user_id, project_space_id, keyword_limit,
        ),
        "graph": lambda: _retrieve_graph_documents(
            query, user_id, project_space_id, graph_limit,
        ),
    }
    documents_by_channel: dict[str, list[dict]] = {channel: [] for channel in selected_routes}
    degraded_channels: set[str] = set()
    channel_errors: dict[str, Exception] = {}

    with ThreadPoolExecutor(max_workers=len(selected_routes), thread_name_prefix="rag-retrieval") as executor:
        futures = {
            executor.submit(lane_calls[channel]): channel
            for channel in selected_routes
        }
        for future in as_completed(futures):
            channel = futures[future]
            try:
                documents_by_channel[channel] = future.result()
                if bool(getattr(documents_by_channel[channel], "backend_degraded", False)):
                    degraded_channels.add(channel)
            except Exception as error:  # noqa: BLE001 - each retrieval lane is an isolation boundary
                channel_errors[channel] = error

    if channel_errors and len(channel_errors) == len(selected_routes):
        failed_channels = ", ".join(channel for channel in RETRIEVAL_CHANNEL_ORDER if channel in channel_errors)
        first_error = channel_errors[next(channel for channel in RETRIEVAL_CHANNEL_ORDER if channel in channel_errors)]
        raise RetrievalChannelsUnavailableError(
            f"All selected retrieval channels failed: {failed_channels}"
        ) from first_error

    channel_status = {
        channel: (
            "error"
            if channel in channel_errors
            else "degraded"
            if channel in degraded_channels
            else "ok"
            if documents_by_channel[channel]
            else "empty"
        )
        for channel in selected_routes
    }

    if not any(documents_by_channel.values()):
        return RetrievalDocuments([], channel_status)

    ranked_lists = [
        (channel, documents_by_channel[channel])
        for channel in RETRIEVAL_CHANNEL_ORDER
        if channel in documents_by_channel
    ]
    # Graph facts are rule-extracted supporting evidence, so they should help
    # corroborate semantic/lexical hits without outweighing both primary lanes.
    fused_documents = reciprocal_rank_fuse(
        ranked_lists,
        weights=RETRIEVAL_CHANNEL_WEIGHTS,
    )
    active_retriever_count = sum(1 for documents in documents_by_channel.values() if documents)
    max_rrf_score = max([float(document.get("rrf_score") or 0) for document in fused_documents] or [0.0])

    results = []
    for document in fused_documents:
        vector_similarity = float((document.get("channel_scores") or {}).get("vector") or document.get("similarity") or 0)
        lexical_score = float((document.get("channel_scores") or {}).get("bm25") or document.get("lexical_score") or 0)
        rrf_score = float(document.get("rrf_score") or 0)
        retrieval_score = round(rrf_score / max_rrf_score, 6) if max_rrf_score > 0 else 0.0
        channels = document.get("retrieval_channels") or []
        if active_retriever_count > 1:
            retrieval_mode = "hybrid_rrf"
        elif "graph" in channels:
            retrieval_mode = "graph"
        elif "bm25" in channels:
            retrieval_mode = "lexical"
        else:
            retrieval_mode = "vector"

        results.append(_prepare_chunk_result(
            document,
            similarity=vector_similarity,
            lexical_score=round(lexical_score, 4),
            retrieval_score=retrieval_score,
            retrieval_mode=retrieval_mode,
            rrf_score=rrf_score,
            retrieval_channels=channels,
            channel_ranks=document.get("channel_ranks") or {},
            channel_scores=document.get("channel_scores") or {},
        ))

    ranked_results = sorted(results, key=lambda result: result["retrieval_score"], reverse=True)
    return RetrievalDocuments(
        _apply_source_diversity(ranked_results, limit),
        channel_status,
    )

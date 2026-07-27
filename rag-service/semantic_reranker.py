from __future__ import annotations

import hashlib
import math

from compatible_api import post_json
from config import settings
from reranker import LOCAL_RERANKER_VERSION, rerank_documents


def _normalized_rank_scores(items: list[tuple[int, float]]) -> dict[int, float]:
    if not items:
        return {}
    values = [score for _, score in items]
    minimum = min(values)
    maximum = max(values)
    if maximum <= minimum:
        return {index: 1.0 for index, _ in items}
    return {
        index: round((score - minimum) / (maximum - minimum), 6)
        for index, score in items
    }


def _parse_provider_results(response: dict, document_count: int) -> list[tuple[int, float]]:
    raw_results = response.get("results") or response.get("data") or []
    if not isinstance(raw_results, list):
        raise ValueError("Reranker response must contain a results list")

    parsed: list[tuple[int, float]] = []
    seen: set[int] = set()
    for item in raw_results:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("index"))
            score = float(item.get("relevance_score", item.get("score")))
        except (TypeError, ValueError):
            continue
        if index < 0 or index >= document_count or index in seen or not math.isfinite(score):
            continue
        seen.add(index)
        parsed.append((index, score))
    if not parsed:
        raise ValueError("Reranker response contained no valid document scores")
    return sorted(parsed, key=lambda value: value[1], reverse=True)


def rerank_with_provider(
    query: str,
    documents: list[dict],
    top_k: int | None = None,
) -> list[dict]:
    """RRF/local enrichment followed by an optional semantic rerank service.

    Provider scores are explicitly marked uncalibrated. Any configuration,
    transport, or schema failure falls back to the deterministic local order.
    """
    local_ranked = rerank_documents(query, documents)
    if not local_ranked:
        return []
    if not settings.reranker_enabled:
        return local_ranked[:top_k] if top_k else local_ranked

    provider_documents = [
        str(document.get("content") or "")[:settings.reranker_max_document_chars]
        for document in local_ranked
    ]
    try:
        response = post_json(
            settings.reranker_base_url,
            settings.reranker_api_key,
            "/rerank",
            {
                "model": settings.reranker_model,
                "query": query,
                "documents": provider_documents,
                "top_n": min(len(provider_documents), settings.reranker_top_n),
                "return_documents": False,
            },
            settings.reranker_timeout_ms / 1000,
        )
        provider_results = _parse_provider_results(response, len(local_ranked))
    except Exception:
        fallback = []
        for document in local_ranked:
            enriched = dict(document)
            enriched["reranker_fallback"] = "provider_unavailable"
            fallback.append(enriched)
        return fallback[:top_k] if top_k else fallback

    normalized_scores = _normalized_rank_scores(provider_results)
    reranked: list[dict] = []
    selected_indices: set[int] = set()
    for rank, (index, raw_score) in enumerate(provider_results, start=1):
        selected_indices.add(index)
        document = dict(local_ranked[index])
        document["pre_semantic_rerank_rank"] = index + 1
        document["semantic_rerank_rank"] = rank
        document["semantic_rerank_score"] = raw_score
        document["rerank_score"] = normalized_scores[index]
        document["agentic_score"] = normalized_scores[index]
        document["reranker"] = settings.reranker_model
        document["reranker_score_type"] = "provider_relevance_uncalibrated"
        reranked.append(document)

    # Some providers only return top_n. Preserve deterministic local candidates
    # after the semantically scored prefix so a low provider top_n never drops
    # all fallback evidence.
    for index, document in enumerate(local_ranked):
        if index in selected_indices:
            continue
        enriched = dict(document)
        enriched["pre_semantic_rerank_rank"] = index + 1
        enriched["semantic_rerank_rank"] = None
        enriched["reranker"] = settings.reranker_model
        enriched["reranker_score_type"] = "provider_not_scored"
        reranked.append(enriched)

    return reranked[:top_k] if top_k else reranked


def reranker_fingerprint() -> str:
    if not settings.reranker_enabled:
        return LOCAL_RERANKER_VERSION
    endpoint_hash = hashlib.sha256(
        settings.reranker_base_url.rstrip("/").encode("utf-8")
    ).hexdigest()[:12]
    return (
        f"compatible:v1:{settings.reranker_model}:endpoint-{endpoint_hash}:"
        f"top-{settings.reranker_top_n}:chars-{settings.reranker_max_document_chars}"
    )

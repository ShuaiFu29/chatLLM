from collections import defaultdict
from typing import Iterable


def _document_key(document: dict) -> str:
    metadata = document.get("metadata") or {}
    return str(
        document.get("id")
        or document.get("chunk_id")
        or f"{metadata.get('file_id', '')}:{metadata.get('chunk_index', '')}"
        or document.get("content", "")
    )


def reciprocal_rank_fuse(
    ranked_lists: Iterable[tuple[str, list[dict]]],
    k: int = 60,
    weights: dict[str, float] | None = None,
) -> list[dict]:
    scores: dict[str, float] = defaultdict(float)
    documents: dict[str, dict] = {}
    channel_ranks: dict[str, dict[str, int]] = defaultdict(dict)
    channel_scores: dict[str, dict[str, float]] = defaultdict(dict)
    channel_order: dict[str, list[str]] = defaultdict(list)

    for channel, ranked_documents in ranked_lists:
        weight = (weights or {}).get(channel, 1.0)
        for index, document in enumerate(ranked_documents, start=1):
            key = _document_key(document)
            if not key:
                continue

            if key not in documents:
                documents[key] = dict(document)

            scores[key] += weight / (k + index)
            channel_ranks[key][channel] = index
            if channel not in channel_order[key]:
                channel_order[key].append(channel)

            raw_score = (
                document.get("retrieval_score")
                or document.get("similarity")
                or document.get("lexical_score")
                or 0
            )
            try:
                channel_scores[key][channel] = float(raw_score)
            except (TypeError, ValueError):
                channel_scores[key][channel] = 0.0

    fused = []
    for key, document in documents.items():
        merged = dict(document)
        merged["id"] = str(document.get("id") or document.get("chunk_id") or key)
        merged["rrf_score"] = round(scores[key], 6)
        merged["retrieval_channels"] = channel_order[key]
        merged["channel_ranks"] = dict(channel_ranks[key])
        merged["channel_scores"] = dict(channel_scores[key])
        fused.append(merged)

    return sorted(fused, key=lambda item: item["rrf_score"], reverse=True)

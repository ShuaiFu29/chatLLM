from collections import defaultdict
from typing import Iterable


_GRAPH_METADATA_LIST_FIELDS = (
    "graph_entities",
    "graph_seed_entities",
    "graph_related_entities",
    "graph_relations",
)


def _merge_unique_values(left: list, right: list) -> list:
    merged = list(left)
    for value in right:
        if value not in merged:
            merged.append(value)
    return merged


def _merge_graph_provenance(target: dict, incoming: dict) -> None:
    target_metadata = dict(target.get("metadata") or {})
    incoming_metadata = incoming.get("metadata") or {}

    for field in _GRAPH_METADATA_LIST_FIELDS:
        incoming_values = incoming_metadata.get(field)
        if isinstance(incoming_values, list) and incoming_values:
            target_metadata[field] = _merge_unique_values(
                target_metadata.get(field) or [],
                incoming_values,
            )

    target["metadata"] = target_metadata
    graph_scores = (target.get("graph_score"), incoming.get("graph_score"))
    numeric_scores = []
    for score in graph_scores:
        try:
            numeric_scores.append(float(score))
        except (TypeError, ValueError):
            continue
    if numeric_scores:
        target["graph_score"] = max(numeric_scores)



def _document_key(document: dict) -> str:
    metadata = document.get("metadata") or {}
    explicit_id = document.get("id") or document.get("chunk_id")
    if explicit_id:
        return str(explicit_id)

    file_id = metadata.get("file_id")
    chunk_index = metadata.get("chunk_index")
    if file_id not in (None, "") and chunk_index is not None:
        return f"{file_id}:{chunk_index}"

    return str(document.get("content") or "")


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
                documents[key] = {
                    **document,
                    "metadata": dict(document.get("metadata") or {}),
                }
            else:
                _merge_graph_provenance(documents[key], document)

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

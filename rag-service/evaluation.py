import re


def _clamp_score(value: float) -> float:
    return max(0.0, min(1.0, round(value, 4)))


def _tokens(value: str) -> set[str]:
    return {token for token in re.findall(r"[\w-]+", value.lower()) if len(token) > 2}


def _term_overlap(query: str, content: str) -> float:
    query_tokens = _tokens(query)
    if not query_tokens:
        return 0.0

    content_tokens = _tokens(content)
    if not content_tokens:
        return 0.0

    return len(query_tokens & content_tokens) / len(query_tokens)


def evaluate_retrieval_quality(query: str, documents: list[dict]) -> dict:
    if not documents:
        return {
            "retrieval_score": 0,
            "citation_score": 0,
            "evidence_score": 0,
            "overall_score": 0,
            "evidence_label": "weak",
        }

    overlap_scores = [_term_overlap(query, str(document.get("content") or "")) for document in documents]
    similarity_scores = [
        float(document.get("similarity") or 0)
        for document in documents
        if isinstance(document.get("similarity"), (int, float))
    ]
    cited_count = 0
    for document in documents:
        metadata = document.get("metadata") or {}
        if metadata.get("file_id") and metadata.get("filename") and metadata.get("chunk_index") is not None:
            cited_count += 1

    retrieval_score = _clamp_score((sum(overlap_scores) / len(overlap_scores)) * 0.55 + (max(similarity_scores or [0]) * 0.45))
    citation_score = _clamp_score(cited_count / len(documents))
    evidence_score = _clamp_score(min(len(documents), 4) / 4 * 0.35 + retrieval_score * 0.65)
    overall_score = _clamp_score(retrieval_score * 0.45 + citation_score * 0.25 + evidence_score * 0.30)

    if overall_score >= 0.72:
        label = "strong"
    elif overall_score >= 0.38:
        label = "partial"
    else:
        label = "weak"

    return {
        "retrieval_score": retrieval_score,
        "citation_score": citation_score,
        "evidence_score": evidence_score,
        "overall_score": overall_score,
        "evidence_label": label,
    }

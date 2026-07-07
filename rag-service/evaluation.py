import re

from reranker import classify_source_role, extract_exact_markers, score_query_coverage


def _clamp_score(value: float) -> float:
    return max(0.0, min(1.0, round(value, 4)))


def _document_confidence(document: dict) -> float:
    for key in ("agentic_score", "rerank_score", "retrieval_confidence", "similarity", "retrieval_score"):
        try:
            value = float(document.get(key) or 0)
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            return _clamp_score(value)
    return 0.0


def evaluate_retrieval_quality(query: str, documents: list[dict]) -> dict:
    if not documents:
        return {
            "retrieval_score": 0,
            "citation_score": 0,
            "evidence_score": 0,
            "overall_score": 0,
            "evidence_label": "weak",
        }

    coverage_scores = [score_query_coverage(query, str(document.get("content") or ""))[0] for document in documents]
    confidence_scores = [_document_confidence(document) for document in documents]
    source_roles = [document.get("source_role") or classify_source_role(document) for document in documents]
    query_exact_markers = extract_exact_markers(query)
    document_exact_markers: set[str] = set()
    for document in documents:
        document_exact_markers.update(extract_exact_markers(str(document.get("content") or "")))
        metadata = document.get("metadata") or {}
        document_exact_markers.update(extract_exact_markers(str(metadata.get("filename") or "")))
    exact_marker_coverage = (
        len(query_exact_markers & document_exact_markers) / len(query_exact_markers)
        if query_exact_markers else 1.0
    )
    cited_count = 0
    source_ids: set[str] = set()
    for document in documents:
        metadata = document.get("metadata") or {}
        if metadata.get("file_id") and metadata.get("filename") and metadata.get("chunk_index") is not None:
            cited_count += 1
        if metadata.get("file_id") or metadata.get("filename"):
            source_ids.add(str(metadata.get("file_id") or metadata.get("filename")))

    average_coverage = sum(coverage_scores) / len(coverage_scores)
    top_confidence = max(confidence_scores or [0])
    average_confidence = sum(confidence_scores) / len(confidence_scores)
    primary_ratio = len([role for role in source_roles if role != "evaluation_guide"]) / len(source_roles)
    direct_evidence_ratio = len([
        document
        for document, coverage in zip(documents, coverage_scores)
        if float(document.get("evidence_specificity") or 0) >= 0.45 or coverage >= 0.35
    ]) / len(documents)
    source_diversity = min(len(source_ids), min(len(documents), 4)) / max(1, min(len(documents), 4))

    retrieval_score = _clamp_score(
        average_coverage * 0.36
        + top_confidence * 0.30
        + primary_ratio * 0.17
        + direct_evidence_ratio * 0.12
        + exact_marker_coverage * 0.05
    )
    citation_score = _clamp_score(cited_count / len(documents))
    evidence_score = _clamp_score(
        average_coverage * 0.25
        + average_confidence * 0.20
        + source_diversity * 0.16
        + primary_ratio * 0.12
        + min(len(documents), 4) / 4 * 0.08
        + direct_evidence_ratio * 0.12
        + exact_marker_coverage * 0.07
    )
    overall_score = _clamp_score(retrieval_score * 0.40 + citation_score * 0.25 + evidence_score * 0.35)

    if (
        overall_score >= 0.68
        and retrieval_score >= 0.52
        and evidence_score >= 0.55
        and citation_score >= 0.8
        and primary_ratio >= 0.75
        and exact_marker_coverage >= 0.75
        and direct_evidence_ratio >= 0.30
    ):
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
        "source_diversity_score": _clamp_score(source_diversity),
        "primary_source_ratio": _clamp_score(primary_ratio),
        "exact_marker_coverage": _clamp_score(exact_marker_coverage),
        "direct_evidence_ratio": _clamp_score(direct_evidence_ratio),
    }

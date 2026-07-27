import re

from reranker import classify_source_role, extract_exact_markers, score_answer_bearing, score_query_coverage


QUERY_STRUCTURE_KEYWORDS = {
    "constraint": (
        "必须", "不得", "禁止", "应当", "应按", "需要", "不能", "是否能", "能否", "允许",
        "must", "shall", "should", "cannot", "prohibited", "required", "allowed",
    ),
    "temporal": (
        "当前", "最新", "废止", "旧口径", "修订版", "生效", "失效", "today", "latest",
        "deprecated", "current", "effective",
    ),
}

MULTI_HOP_TERMS = (
    "关系", "关联", "依赖", "影响", "链路", "为什么", "同时", "并读", "对比", "区别", "还是",
    "relationship", "depend", "compare", "difference", "why", "together",
)


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, round(value, 4)))


def _normalize_marker(value: str) -> str:
    return re.sub(r"\s+", "", value or "").upper()


def extract_required_markers(value: str) -> set[str]:
    markers = set(extract_exact_markers(value or ""))
    for token in re.findall(r"\b[A-Z][A-Z0-9_]{1,15}\b", value or ""):
        markers.add(_normalize_marker(token))
    for token in re.findall(r"\b(?:19|20)\d{2}\b", value or ""):
        markers.add(_normalize_marker(token))
    return markers


def _normalized_text(value: str) -> str:
    return (value or "").lower().replace(" ", "")


def assess_query_risk(query: str) -> dict:
    normalized = _normalized_text(query)
    risk_factors: list[str] = []
    for factor, keywords in QUERY_STRUCTURE_KEYWORDS.items():
        if any(_normalized_text(keyword) in normalized for keyword in keywords):
            risk_factors.append(factor)

    if extract_required_markers(query) or re.search(r"\d", query or ""):
        risk_factors.append("exact_marker")
    if any(_normalized_text(term) in normalized for term in MULTI_HOP_TERMS):
        risk_factors.append("multi_hop")

    risk_factors = sorted(set(risk_factors))
    factors = set(risk_factors)
    if "exact_marker" in factors and factors & {"constraint", "temporal", "multi_hop"}:
        risk_level = "high"
    elif len(factors) >= 3:
        risk_level = "high"
    elif factors:
        risk_level = "medium"
    else:
        risk_level = "low"

    return {
        "risk_level": risk_level,
        "risk_factors": risk_factors,
        "requires_strict_evidence": risk_level == "high",
    }


def _document_rank_signal(document: dict) -> float:
    for key in ("agentic_score", "rerank_score", "retrieval_confidence", "similarity", "retrieval_score"):
        try:
            value = float(document.get(key) or 0)
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            return _clamp(value)
    return 0.0


def _source_id(document: dict) -> str:
    metadata = document.get("metadata") or {}
    return str(metadata.get("file_id") or metadata.get("filename") or document.get("id") or "")


def verify_evidence_support(
    query: str,
    documents: list[dict],
    cache_hit_type: str | None = None,
    query_similarity: float | None = None,
) -> dict:
    risk = assess_query_risk(query)
    if not documents:
        return {
            **risk,
            "verification_scope": "evidence_support",
            "answer_evaluated": False,
            "score_type": "heuristic_evidence_support",
            "calibrated": False,
            "rank_signal_score": 0.0,
            "support_label": "unsupported",
            "support_score": 0.0,
            "key_term_coverage": 0.0,
            "exact_marker_coverage": 0.0,
            "exact_marker_applicable": bool(extract_required_markers(query)),
            "matched_markers": [],
            "missing_markers": sorted(extract_required_markers(query)),
            "source_diversity_score": 0.0,
            "primary_source_ratio": None,
            "source_role_applicable": False,
            "answer_bearing_score": 0.0,
            "cache_reuse_allowed": False,
            "must_retrieve": True,
            "reasons": ["no_evidence"],
        }

    combined_parts: list[str] = []
    document_markers: set[str] = set()
    source_roles: list[str] = []
    source_ids: set[str] = set()
    rank_signals: list[float] = []
    answer_bearing_scores: list[float] = []
    for document in documents:
        metadata = document.get("metadata") or {}
        content = str(document.get("content") or "")
        filename = str(metadata.get("filename") or document.get("filename") or "")
        combined_parts.extend([content, filename])
        document_markers.update(extract_required_markers(content))
        document_markers.update(extract_required_markers(filename))
        source_roles.append(document.get("source_role") or classify_source_role(document))
        source_id = _source_id(document)
        if source_id:
            source_ids.add(source_id)
        rank_signals.append(_document_rank_signal(document))
        answer_bearing_scores.append(score_answer_bearing(query, content))

    combined_content = "\n".join(combined_parts)
    key_term_coverage, matched_terms = score_query_coverage(query, combined_content)
    required_markers = extract_required_markers(query)
    exact_marker_applicable = bool(required_markers)
    matched_markers = sorted(required_markers & document_markers)
    missing_markers = sorted(required_markers - document_markers)
    exact_marker_coverage = (
        len(matched_markers) / len(required_markers)
        if exact_marker_applicable else 0.0
    )
    classified_roles = [role for role in source_roles if role in {"primary", "deprecated"}]
    primary_source_ratio = (
        len([role for role in classified_roles if role == "primary"]) / len(classified_roles)
        if classified_roles else None
    )
    deprecated_ratio = (
        len([role for role in classified_roles if role == "deprecated"]) / len(classified_roles)
        if classified_roles else 0.0
    )
    answer_bearing_score = max(answer_bearing_scores or [0.0])
    source_diversity_score = min(len(source_ids), min(len(documents), 4)) / max(1, min(len(documents), 4))
    top_rank_signal = max(rank_signals or [0.0])

    support_components = [(key_term_coverage, 0.65), (answer_bearing_score, 0.35)]
    if exact_marker_applicable:
        support_components.append((exact_marker_coverage, 0.25))
    support_weight = sum(weight for _, weight in support_components)
    support_score = _clamp(
        sum(score * weight for score, weight in support_components) / support_weight
    )

    reasons: list[str] = []
    if missing_markers:
        reasons.append("missing_required_markers")
    if key_term_coverage < 0.28:
        reasons.append("low_key_term_coverage")
    if answer_bearing_score < 0.34:
        reasons.append("no_answer_bearing_evidence")
    if deprecated_ratio > 0 and risk["risk_level"] == "high":
        reasons.append("deprecated_evidence_in_high_risk_query")

    if (
        support_score >= 0.72
        and (not exact_marker_applicable or exact_marker_coverage >= 0.85)
        and key_term_coverage >= 0.35
        and answer_bearing_score >= 0.34
        and "deprecated_evidence_in_high_risk_query" not in reasons
    ):
        support_label = "supported"
    elif support_score >= 0.42 and not (risk["risk_level"] == "high" and key_term_coverage < 0.28):
        support_label = "partial"
    else:
        support_label = "unsupported"

    if risk["risk_level"] == "high" and missing_markers:
        support_label = "partial" if support_score >= 0.42 else "unsupported"

    min_cache_similarity = 0.55 if cache_hit_type == "subquery" else 0.78
    cache_similarity_ok = query_similarity is None or query_similarity >= min_cache_similarity
    cache_blocking_reasons = {
        "deprecated_evidence_in_high_risk_query",
        "no_answer_bearing_evidence",
    }
    reason_set = set(reasons)
    has_cache_blocking_reason = bool(cache_blocking_reasons & reason_set)
    cache_reuse_allowed = (
        bool(cache_hit_type)
        and support_label == "supported"
        and cache_similarity_ok
        and not missing_markers
        and answer_bearing_score >= 0.55
        and not (risk["risk_level"] == "high" and support_score < 0.75)
        and not has_cache_blocking_reason
    )
    must_retrieve = (
        support_label == "unsupported"
        or (bool(cache_hit_type) and not cache_reuse_allowed)
        or (risk["risk_level"] == "high" and (missing_markers or support_score < 0.65))
    )
    if cache_hit_type and not cache_similarity_ok:
        reasons.append("cache_query_similarity_too_low")

    return {
        **risk,
        "verification_scope": "evidence_support",
        "answer_evaluated": False,
        "score_type": "heuristic_evidence_support",
        "calibrated": False,
        "rank_signal_score": _clamp(top_rank_signal),
        "support_label": support_label,
        "support_score": support_score,
        "key_term_coverage": _clamp(key_term_coverage),
        "exact_marker_coverage": _clamp(exact_marker_coverage),
        "exact_marker_applicable": exact_marker_applicable,
        "matched_markers": matched_markers,
        "missing_markers": missing_markers,
        "matched_terms": matched_terms[:20],
        "source_diversity_score": _clamp(source_diversity_score),
        "primary_source_ratio": _clamp(primary_source_ratio) if primary_source_ratio is not None else None,
        "source_role_applicable": bool(classified_roles),
        "answer_bearing_score": _clamp(answer_bearing_score),
        "cache_reuse_allowed": cache_reuse_allowed,
        "must_retrieve": must_retrieve,
        "reasons": sorted(set(reasons)),
    }

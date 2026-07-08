import re

from reranker import classify_source_role, extract_exact_markers, score_query_coverage


RISK_KEYWORDS = {
    "regulatory": (
        "合规", "监管", "法规", "制度", "政策", "规程", "规范", "审批", "审计", "留痕",
        "regulation", "regulatory", "compliance", "policy", "audit", "approval",
    ),
    "legal": (
        "法律", "法务", "责任", "处罚", "诉讼", "保全", "合同", "义务",
        "legal", "liability", "lawsuit", "contract", "obligation",
    ),
    "medical": (
        "患者", "诊疗", "临床", "病历", "医保", "医疗", "检验", "质控",
        "patient", "clinical", "medical", "diagnosis", "insurance",
    ),
    "finance": (
        "金额", "支付", "赔付", "费用", "发票", "税", "结算", "预算", "采购",
        "payment", "claim", "invoice", "tax", "settlement", "budget",
    ),
    "security": (
        "安全", "事故", "取证", "权限", "泄露", "密钥", "漏洞",
        "security", "incident", "forensic", "breach", "permission", "secret",
    ),
    "obligation": (
        "必须", "不得", "禁止", "应当", "应按", "需要", "不能", "是否能", "能否", "允许",
        "must", "shall", "should", "cannot", "prohibited", "required", "allowed",
    ),
    "cross_region": (
        "跨境", "出境", "欧盟", "华东", "华南", "华北", "cn", "eu", "us", "asia",
        "cross-border", "cross region", "regional",
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
    for token in re.findall(r"\b(?:CN|EU|US|UK|AI|API|SRE|BMS|NMPA|FDA|GDPR)\b", value or "", re.IGNORECASE):
        markers.add(_normalize_marker(token))
    for token in re.findall(r"\b(?:19|20)\d{2}\b", value or ""):
        markers.add(_normalize_marker(token))
    return markers


def _normalized_text(value: str) -> str:
    return (value or "").lower().replace(" ", "")


def requires_cross_region_corroboration(value: str) -> bool:
    normalized = _normalized_text(value)
    if any(marker in normalized for marker in ("跨境", "出境", "cross-border", "crossregion")):
        return True

    region_markers: set[str] = set()
    marker_patterns = {
        "cn": (r"\bcn\b", "中国", "境内"),
        "eu": (r"\beu\b", "欧盟", "欧洲"),
        "us": (r"\bus\b", "美国"),
        "uk": (r"\buk\b", "英国"),
        "asia": (r"\basia\b", "亚洲"),
    }
    for marker, patterns in marker_patterns.items():
        for pattern in patterns:
            if pattern.startswith(r"\b"):
                if re.search(pattern, value or "", re.IGNORECASE):
                    region_markers.add(marker)
                    break
            elif pattern in (value or ""):
                region_markers.add(marker)
                break

    return len(region_markers) >= 2


def assess_query_risk(query: str) -> dict:
    normalized = _normalized_text(query)
    risk_factors: list[str] = []
    for factor, keywords in RISK_KEYWORDS.items():
        if any(_normalized_text(keyword) in normalized for keyword in keywords):
            risk_factors.append(factor)

    if extract_required_markers(query) or re.search(r"\d", query or ""):
        risk_factors.append("numeric_or_exact_marker")
    if any(_normalized_text(term) in normalized for term in MULTI_HOP_TERMS):
        risk_factors.append("multi_hop")

    risk_factors = sorted(set(risk_factors))
    high_signals = {"regulatory", "legal", "medical", "finance", "security"}
    if high_signals & set(risk_factors) and (
        {"obligation", "cross_region", "temporal", "numeric_or_exact_marker", "multi_hop"} & set(risk_factors)
    ):
        risk_level = "high"
    elif {"cross_region", "numeric_or_exact_marker"} <= set(risk_factors) and (
        {"obligation", "temporal", "multi_hop"} & set(risk_factors)
    ):
        risk_level = "high"
    elif len(risk_factors) >= 2 or "numeric_or_exact_marker" in risk_factors:
        risk_level = "medium"
    else:
        risk_level = "low"

    return {
        "risk_level": risk_level,
        "risk_factors": risk_factors,
        "requires_strict_evidence": risk_level == "high",
    }


def _document_confidence(document: dict) -> float:
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
            "support_label": "unsupported",
            "support_score": 0.0,
            "key_term_coverage": 0.0,
            "exact_marker_coverage": 0.0,
            "matched_markers": [],
            "missing_markers": sorted(extract_required_markers(query)),
            "source_diversity_score": 0.0,
            "primary_source_ratio": 0.0,
            "cache_reuse_allowed": False,
            "must_retrieve": True,
            "reasons": ["no_evidence"],
        }

    combined_parts: list[str] = []
    document_markers: set[str] = set()
    source_roles: list[str] = []
    source_ids: set[str] = set()
    confidences: list[float] = []
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
        confidences.append(_document_confidence(document))

    combined_content = "\n".join(combined_parts)
    key_term_coverage, matched_terms = score_query_coverage(query, combined_content)
    required_markers = extract_required_markers(query)
    matched_markers = sorted(required_markers & document_markers)
    missing_markers = sorted(required_markers - document_markers)
    exact_marker_coverage = (
        len(matched_markers) / len(required_markers)
        if required_markers else 1.0
    )
    primary_count = len([role for role in source_roles if role not in {"evaluation_guide"}])
    primary_source_ratio = primary_count / len(source_roles)
    deprecated_ratio = len([role for role in source_roles if role == "deprecated"]) / len(source_roles)
    guide_ratio = len([role for role in source_roles if role == "evaluation_guide"]) / len(source_roles)
    source_diversity_score = min(len(source_ids), min(len(documents), 4)) / max(1, min(len(documents), 4))
    top_confidence = max(confidences or [0.0])

    source_quality = _clamp(primary_source_ratio - guide_ratio * 0.45 - deprecated_ratio * 0.20)
    support_score = _clamp(
        key_term_coverage * 0.34
        + exact_marker_coverage * 0.28
        + source_quality * 0.16
        + top_confidence * 0.12
        + source_diversity_score * 0.10
    )

    reasons: list[str] = []
    if missing_markers:
        reasons.append("missing_required_markers")
    if key_term_coverage < 0.28:
        reasons.append("low_key_term_coverage")
    if guide_ratio > 0.35:
        reasons.append("evaluation_guide_dominates")
    if deprecated_ratio > 0 and risk["risk_level"] == "high":
        reasons.append("deprecated_evidence_in_high_risk_query")
    if risk["risk_level"] == "high" and len(source_ids) < 2 and any(term in risk["risk_factors"] for term in ("multi_hop", "cross_region")):
        reasons.append("limited_source_diversity_for_high_risk_query")

    if (
        support_score >= 0.72
        and exact_marker_coverage >= 0.85
        and key_term_coverage >= 0.35
        and primary_source_ratio >= 0.50
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
        "evaluation_guide_dominates",
    }
    reason_set = set(reasons)
    source_diversity_blocks_cache = (
        "limited_source_diversity_for_high_risk_query" in reason_set
        and requires_cross_region_corroboration(query)
    )
    has_cache_blocking_reason = bool(cache_blocking_reasons & reason_set) or source_diversity_blocks_cache
    cache_reuse_allowed = (
        bool(cache_hit_type)
        and support_label == "supported"
        and cache_similarity_ok
        and not missing_markers
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
        "support_label": support_label,
        "support_score": support_score,
        "key_term_coverage": _clamp(key_term_coverage),
        "exact_marker_coverage": _clamp(exact_marker_coverage),
        "matched_markers": matched_markers,
        "missing_markers": missing_markers,
        "matched_terms": matched_terms[:20],
        "source_diversity_score": _clamp(source_diversity_score),
        "primary_source_ratio": _clamp(primary_source_ratio),
        "cache_reuse_allowed": cache_reuse_allowed,
        "must_retrieve": must_retrieve,
        "reasons": sorted(set(reasons)),
    }

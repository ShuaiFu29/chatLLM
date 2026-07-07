import re


EXACT_MARKER_RE = re.compile(
    r"T\+\d+"
    r"|\d{4}-\d{2}-\d{2}"
    r"|[A-Za-z]+(?:-[A-Za-z0-9]+)+"
    r"|\d+(?:\.\d+)?\s?(?:MW|KW|MWH|KWH|%)",
    re.IGNORECASE,
)

EVALUATION_GUIDE_MARKERS = (
    "test-guide",
    "corpus-index",
    "eval-guide",
    "evaluation-guide",
    "评测指南",
    "建议评测问题",
    "期望来源文档",
    "rag 压力测试知识库索引",
)

BOILERPLATE_MARKERS = (
    "本文件围绕",
    "资料进入专项夹",
    "这一点在多份材料中反复出现",
    "整理人保留了原始措辞",
    "关联说明：本材料夹中的文件",
    "上表不是要求统一删改",
)

INDEX_FILENAME_MARKERS = (
    "目录",
    "索引",
    "移交清单",
)


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, round(value, 6)))


def _normalize_marker(value: str) -> str:
    return re.sub(r"\s+", "", value).upper()


def extract_exact_markers(value: str) -> set[str]:
    return {_normalize_marker(match.group(0)) for match in EXACT_MARKER_RE.finditer(value or "")}


def _cjk_terms(value: str) -> set[str]:
    terms: set[str] = set()
    for sequence in re.findall(r"[\u4e00-\u9fff]{2,}", value or ""):
        if len(sequence) <= 8:
            terms.add(sequence)
        for size in (2, 3, 4):
            if len(sequence) >= size:
                for index in range(0, len(sequence) - size + 1):
                    terms.add(sequence[index:index + size])
    return terms


def extract_terms(value: str) -> set[str]:
    text = value or ""
    terms = extract_exact_markers(text)
    terms.update(_cjk_terms(text))
    for token in re.findall(r"\b[A-Z]{2,}\b", text):
        terms.add(_normalize_marker(token))
    for token in re.findall(r"[A-Za-z][A-Za-z0-9_]+", text):
        if len(token) > 2:
            terms.add(token.lower())
    return {term for term in terms if term}


def _term_weight(term: str) -> float:
    if term in extract_exact_markers(term) or re.search(r"\d|[+%]", term):
        return 3.0
    if re.search(r"[\u4e00-\u9fff]", term):
        return 1.35 if len(term) <= 2 else 1.6
    return 1.0


def score_query_coverage(query: str, content: str) -> tuple[float, list[str]]:
    query_terms = extract_terms(query)
    if not query_terms:
        return 0.0, []

    content_terms = extract_terms(content)
    matched = sorted(query_terms & content_terms, key=lambda value: (-_term_weight(value), value))
    total_weight = sum(_term_weight(term) for term in query_terms)
    matched_weight = sum(_term_weight(term) for term in matched)
    if total_weight <= 0:
        return 0.0, []
    return _clamp(matched_weight / total_weight), matched


def classify_source_role(document: dict) -> str:
    metadata = document.get("metadata") or {}
    filename = str(metadata.get("filename") or document.get("filename") or "").lower()
    content = str(document.get("content") or "").lower()
    combined = f"{filename}\n{content}"

    if any(marker in combined for marker in EVALUATION_GUIDE_MARKERS):
        return "evaluation_guide"
    if "deprecated" in combined or "已废止" in combined:
        return "deprecated"
    if any(marker in filename for marker in INDEX_FILENAME_MARKERS) and _boilerplate_penalty(str(document.get("content") or "")) >= 0.1:
        return "index"
    return "primary"


def _source_quality(role: str) -> float:
    if role == "evaluation_guide":
        return 0.12
    if role == "index":
        return 0.72
    if role == "deprecated":
        return 0.78
    return 1.0


def _raw_retrieval_score(document: dict) -> float:
    for key in ("retrieval_score", "similarity", "rrf_score", "lexical_score"):
        try:
            value = float(document.get(key) or 0)
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            return value
    return 0.0


def _channel_bonus(document: dict) -> float:
    channels = document.get("retrieval_channels") or []
    if not isinstance(channels, list):
        return 0.0
    return _clamp(min(len(set(channels)), 3) / 3)


def _filename_text(document: dict) -> str:
    metadata = document.get("metadata") or {}
    filename = str(metadata.get("filename") or document.get("filename") or "")
    return re.sub(r"\.[A-Za-z0-9]+$", "", filename)


def score_filename_match(query: str, document: dict) -> float:
    filename_terms = extract_terms(_filename_text(document))
    query_terms = extract_terms(query)
    if not filename_terms or not query_terms:
        return 0.0

    matched = filename_terms & query_terms
    if not matched:
        return 0.0

    matched_weight = sum(_term_weight(term) for term in matched)
    filename_weight = sum(_term_weight(term) for term in filename_terms)
    query_weight = sum(_term_weight(term) for term in query_terms)
    if filename_weight <= 0 or query_weight <= 0:
        return 0.0

    # Require the filename to explain a meaningful part of itself and a small
    # but real part of the query; this keeps generic short filenames from
    # dominating while strongly rewarding domain-document names such as BMS.
    filename_side = matched_weight / filename_weight
    query_side = matched_weight / query_weight
    score = filename_side * 0.60 + min(query_side * 3.0, 1.0) * 0.40
    if any(re.search(r"[A-Z0-9]", term) or (term.isascii() and 2 <= len(term) <= 12) for term in matched):
        score = max(score, min(0.82, 0.42 + len(matched) * 0.04))
    return _clamp(score)


def _boilerplate_penalty(content: str) -> float:
    normalized = content or ""
    hits = sum(1 for marker in BOILERPLATE_MARKERS if marker in normalized)
    return _clamp(min(hits, 3) * 0.10)


def _classify_evidence_specificity(
    query: str,
    document: dict,
    coverage_score: float,
    exact_score: float,
    filename_match_score: float,
) -> float:
    content = str(document.get("content") or "")
    query_exact_markers = extract_exact_markers(query)
    content_exact_markers = extract_exact_markers(content)
    exact_marker_coverage = (
        len(query_exact_markers & content_exact_markers) / len(query_exact_markers)
        if query_exact_markers else exact_score
    )
    specificity = (
        coverage_score * 0.34
        + exact_score * 0.24
        + filename_match_score * 0.24
        + exact_marker_coverage * 0.18
    )
    return _clamp(specificity - _boilerplate_penalty(content))


def rerank_documents(query: str, documents: list[dict], top_k: int | None = None) -> list[dict]:
    max_retrieval_score = max([_raw_retrieval_score(document) for document in documents] or [0.0])
    query_exact_markers = extract_exact_markers(query)
    ranked = []
    for index, document in enumerate(documents, start=1):
        raw_retrieval_score = _raw_retrieval_score(document)
        retrieval_confidence = raw_retrieval_score / max_retrieval_score if max_retrieval_score > 0 else 0.0
        coverage_score, matched_terms = score_query_coverage(query, str(document.get("content") or ""))
        content_exact_markers = extract_exact_markers(str(document.get("content") or ""))
        exact_score = (
            len(query_exact_markers & content_exact_markers) / len(query_exact_markers)
            if query_exact_markers else coverage_score
        )
        role = classify_source_role(document)
        filename_match_score = score_filename_match(query, document)
        evidence_specificity = _classify_evidence_specificity(
            query,
            document,
            coverage_score,
            exact_score,
            filename_match_score,
        )
        source_quality = _source_quality(role)
        base_score = (
            retrieval_confidence * 0.14
            + coverage_score * 0.30
            + exact_score * 0.20
            + filename_match_score * 0.18
            + evidence_specificity * 0.10
            + source_quality * 0.05
            + _channel_bonus(document) * 0.03
        )
        if role == "evaluation_guide":
            base_score *= 0.45
        elif role == "primary" and (exact_score > 0 or filename_match_score >= 0.25):
            base_score += 0.05
        if filename_match_score >= 0.35 and evidence_specificity >= 0.45:
            base_score += 0.08
        if evidence_specificity < 0.25:
            base_score *= 0.88

        rerank_score = _clamp(base_score)
        enriched = dict(document)
        enriched["pre_rerank_rank"] = index
        enriched["rerank_score"] = rerank_score
        enriched["agentic_score"] = rerank_score
        enriched["reranker"] = "local-evidence"
        enriched["source_role"] = role
        enriched["source_quality"] = source_quality
        enriched["term_coverage"] = coverage_score
        enriched["exact_match_score"] = _clamp(exact_score)
        enriched["filename_match_score"] = filename_match_score
        enriched["evidence_specificity"] = evidence_specificity
        enriched["retrieval_confidence"] = _clamp(retrieval_confidence)
        enriched["matched_terms"] = matched_terms
        ranked.append(enriched)

    ranked.sort(key=lambda item: item["rerank_score"], reverse=True)
    return ranked[:top_k] if top_k else ranked

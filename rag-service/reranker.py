import re


LOCAL_RERANKER_VERSION = "local-evidence-v2"


EXACT_MARKER_RE = re.compile(
    r"(?<![A-Za-z0-9_])T\+\d+(?![A-Za-z0-9_])"
    r"|(?<![A-Za-z0-9_])\d{4}-\d{2}-\d{2}(?![A-Za-z0-9_])"
    r"|(?<![A-Za-z0-9_])v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.]+)?(?![A-Za-z0-9_])"
    r"|(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]*(?:[-_.][A-Za-z0-9_]+)+(?![A-Za-z0-9_])"
    r"|(?:[$€£¥￥]\s*\d+(?:\.\d+)?)"
    r"|\b\d+(?:\.\d+)?\s?(?:%|ms|s|sec|secs|seconds?|min|mins|minutes?|h|hr|hrs|hours?|d|days?|"
    r"hz|khz|mhz|ghz|b|kb|mb|gb|tb|v|kv|a|ma|w|kw|mw|wh|kwh|mwh|"
    r"pa|kpa|mpa|bar|°c|kg|g|mg|mm|cm|m|km|元|万元|秒|分钟|小时|天|周|个月|年)"
    r"(?![A-Za-z0-9_])",
    re.IGNORECASE,
)

TERM_STOPWORDS = {
    "a", "an", "and", "are", "as", "be", "by", "do", "does", "for", "from",
    "how", "in", "is", "of", "on", "or", "the", "to", "what", "when", "where",
    "which", "who", "why", "with",
}

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
        normalized = token.lower()
        if len(normalized) > 2 and normalized not in TERM_STOPWORDS:
            terms.add(normalized)
    return {term for term in terms if term}


def score_answer_bearing(query: str, content: str) -> float:
    """Estimate whether a passage contains information beyond restating the query.

    This is a conservative lexical gate, not an entailment probability. It is
    primarily used to prevent question-only FAQ headings from being labelled as
    strong evidence or approving an exact-cache short circuit.
    """
    query_text = re.sub(r"\s+", "", query or "").casefold().rstrip("?？")
    content_text = re.sub(r"\s+", "", content or "").casefold()
    content_body = re.sub(r"^(?:faq|question|q|问题|问)[:：\-]?", "", content_text).rstrip("?？")
    if not content_body or content_body == query_text:
        return 0.0

    query_terms = extract_terms(query)
    novel_terms = extract_terms(content) - query_terms - {"faq", "question"}
    lexical_signal = min(1.0, len(novel_terms) / 3)

    query_numbers = set(re.findall(r"\d+(?:\.\d+)?", query or ""))
    content_numbers = set(re.findall(r"\d+(?:\.\d+)?", content or ""))
    fact_marker_signal = 1.0 if (extract_exact_markers(content) - extract_exact_markers(query)) or (content_numbers - query_numbers) else 0.0
    length_signal = min(1.0, max(0, len(content_body) - len(query_text)) / max(40, len(query_text)))
    score = max(fact_marker_signal * 0.8, lexical_signal * 0.75 + length_signal * 0.25)

    stripped = (content or "").strip()
    if stripped.endswith(("?", "？")) and not re.search(r"[。.!；;]\s*\S", stripped):
        score = min(score, 0.25)
    return _clamp(score)


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
    """Return an explicitly supplied role without guessing from corpus text."""
    metadata = document.get("metadata") or {}
    role = document.get("source_role") or metadata.get("source_role")
    return str(role).strip() if role else "unclassified"


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
    # dominating while still rewarding distinctive domain document names.
    filename_side = matched_weight / filename_weight
    query_side = matched_weight / query_weight
    score = filename_side * 0.60 + min(query_side * 3.0, 1.0) * 0.40
    if any(re.search(r"[A-Z0-9]", term) or (term.isascii() and 2 <= len(term) <= 12) for term in matched):
        score = max(score, min(0.82, 0.42 + len(matched) * 0.04))
    return _clamp(score)


def _heading_text(document: dict) -> str:
    metadata = document.get("metadata") or {}
    heading_path = metadata.get("heading_path") or document.get("heading_path") or []
    if isinstance(heading_path, list):
        return " ".join(str(value).strip() for value in heading_path if str(value).strip())
    return str(heading_path or "").strip()


def score_heading_match(query: str, document: dict) -> float:
    heading = _heading_text(document)
    if not heading:
        return 0.0
    coverage, _ = score_query_coverage(query, heading)
    normalized_heading = re.sub(r"[^\w\u3400-\u4dbf\u4e00-\u9fff]+", "", heading).casefold()
    normalized_query = re.sub(r"[^\w\u3400-\u4dbf\u4e00-\u9fff]+", "", query).casefold()
    if normalized_heading and normalized_heading in normalized_query:
        coverage = max(coverage, 0.9)
    return _clamp(coverage)


def _ordered_query_units(query: str) -> list[str]:
    units: list[str] = []
    seen: set[str] = set()
    for marker in sorted(extract_exact_markers(query), key=len, reverse=True):
        normalized = marker.casefold()
        if normalized not in seen:
            seen.add(normalized)
            units.append(normalized)
    for token in re.findall(r"[A-Za-z][A-Za-z0-9_]+", query or ""):
        normalized = token.casefold()
        if len(normalized) > 2 and normalized not in TERM_STOPWORDS and normalized not in seen:
            seen.add(normalized)
            units.append(normalized)
    for sequence in re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]{2,}", query or ""):
        cleaned = re.sub(
            r"(?:请问|请说明|请介绍|请分析|请解释|如何|怎么|怎样|为什么|为何|是什么|"
            r"有哪些|有什么|是否|能否|可以|以及|或者)",
            " ",
            sequence,
        )
        for token in cleaned.split():
            normalized = token.casefold()
            if len(normalized) >= 2 and normalized not in seen:
                seen.add(normalized)
                units.append(normalized)
    return units[:12]


def score_phrase_proximity(query: str, content: str) -> float:
    haystack = re.sub(r"\s+", " ", content or "").casefold()
    units = _ordered_query_units(query)
    if not haystack or not units:
        return 0.0
    positions = [(unit, haystack.find(unit)) for unit in units]
    matched = [(unit, position) for unit, position in positions if position >= 0]
    coverage = len(matched) / len(units)
    if len(matched) == 1:
        return _clamp(coverage * 0.35)
    if not matched:
        return 0.0
    start = min(position for _, position in matched)
    end = max(position + len(unit) for unit, position in matched)
    span = max(1, end - start)
    payload_length = sum(len(unit) for unit, _ in matched)
    proximity = min(1.0, payload_length / span)
    return _clamp(coverage * (0.45 + proximity * 0.55))


def _source_key(document: dict) -> str:
    metadata = document.get("metadata") or {}
    return str(
        metadata.get("file_id")
        or document.get("file_id")
        or metadata.get("filename")
        or document.get("filename")
        or ""
    )


def _content_similarity(left: str, right: str) -> float:
    left_terms = extract_terms(left)
    right_terms = extract_terms(right)
    if not left_terms or not right_terms:
        left_normalized = re.sub(r"\s+", "", left or "").casefold()
        right_normalized = re.sub(r"\s+", "", right or "").casefold()
        return 1.0 if left_normalized and left_normalized == right_normalized else 0.0
    return len(left_terms & right_terms) / len(left_terms | right_terms)


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
    return _clamp(specificity)


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
        heading_match_score = score_heading_match(query, document)
        phrase_proximity_score = score_phrase_proximity(
            query,
            "\n".join(filter(None, (_heading_text(document), str(document.get("content") or "")))),
        )
        answer_bearing_score = score_answer_bearing(query, str(document.get("content") or ""))
        evidence_specificity = _classify_evidence_specificity(
            query,
            document,
            coverage_score,
            exact_score,
            filename_match_score,
        )
        base_score = (
            retrieval_confidence * 0.44
            + coverage_score * 0.18
            + exact_score * 0.12
            + heading_match_score * 0.08
            + phrase_proximity_score * 0.06
            + answer_bearing_score * 0.07
            + filename_match_score * 0.03
            + evidence_specificity * 0.01
            + _channel_bonus(document) * 0.01
        )
        stripped_content = str(document.get("content") or "").strip()
        question_like = stripped_content.endswith(("?", "？")) or bool(
            re.match(r"^(?:faq|question|q|问题|问)[:：\-]", stripped_content, re.IGNORECASE)
        )
        question_only_penalty = (
            0.22
            if question_like and answer_bearing_score <= 0.1 and coverage_score >= 0.7
            else 0.0
        )

        rerank_score = _clamp(base_score - question_only_penalty)
        enriched = dict(document)
        enriched["pre_rerank_rank"] = index
        enriched["rerank_score"] = rerank_score
        enriched["agentic_score"] = rerank_score
        enriched["reranker"] = LOCAL_RERANKER_VERSION
        enriched["source_role"] = role
        enriched["source_quality"] = 1.0 if role == "primary" else 0.0 if role == "deprecated" else None
        enriched["term_coverage"] = coverage_score
        enriched["exact_match_score"] = _clamp(exact_score)
        enriched["filename_match_score"] = filename_match_score
        enriched["heading_match_score"] = heading_match_score
        enriched["phrase_proximity_score"] = phrase_proximity_score
        enriched["answer_bearing_score"] = answer_bearing_score
        enriched["question_only_penalty"] = question_only_penalty
        enriched["evidence_specificity"] = evidence_specificity
        enriched["retrieval_confidence"] = _clamp(retrieval_confidence)
        enriched["matched_terms"] = matched_terms
        ranked.append(enriched)

    ranked.sort(key=lambda item: (-item["rerank_score"], item["pre_rerank_rank"]))

    # Suppress repeated chunks from the same source after relevance scoring.
    # Cross-source repetition is retained because it may be independent
    # corroboration rather than duplicate ingestion.
    preceding: list[dict] = []
    for document in ranked:
        source_key = _source_key(document)
        similarity = max(
            (
                _content_similarity(str(document.get("content") or ""), str(previous.get("content") or ""))
                for previous in preceding
                if source_key and _source_key(previous) == source_key
            ),
            default=0.0,
        )
        penalty = 0.12 if similarity >= 0.98 else 0.06 if similarity >= 0.85 else 0.0
        document["base_rerank_score"] = document["rerank_score"]
        document["duplicate_similarity"] = _clamp(similarity)
        document["duplicate_penalty"] = penalty
        if penalty:
            document["rerank_score"] = _clamp(document["rerank_score"] - penalty)
            document["agentic_score"] = document["rerank_score"]
        preceding.append(document)

    ranked.sort(key=lambda item: (-item["rerank_score"], item["pre_rerank_rank"]))
    return ranked[:top_k] if top_k else ranked

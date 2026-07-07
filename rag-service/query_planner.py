import re

from reranker import extract_exact_markers


_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "by",
    "for",
    "from",
    "how",
    "in",
    "is",
    "of",
    "on",
    "or",
    "the",
    "to",
    "what",
    "when",
    "where",
    "which",
    "why",
    "with",
}

_DOMAIN_HINTS = {
    "版本": ("2025", "2026", "废止", "修订", "deprecated", "trial", "revised"),
    "区域": ("华东", "南网", "区域", "附件", "E-2", "S-DR-4"),
    "结算": ("结算", "容量", "电价", "偏差", "公式", "质量系数"),
    "碳核算": ("碳", "绿证", "减排", "核算"),
    "事故": ("事故", "事件", "复盘", "A-17", "遥测", "SOC"),
}


def _normalize_query(query: str) -> str:
    return re.sub(r"\s+", " ", query.strip())


def _keywords(query: str) -> list[str]:
    words = []
    seen = set()
    for token in re.findall(r"[A-Za-z][A-Za-z0-9-]*|[\w-]+", query):
        normalized = token.lower()
        is_short_acronym = len(token) >= 2 and token.upper() == token and re.search(r"[A-Z]", token)
        if (len(normalized) > 2 or is_short_acronym) and normalized not in _STOPWORDS and normalized not in seen:
            seen.add(normalized)
            words.append(token if is_short_acronym else normalized)
    return words


def _domain_terms(query: str) -> list[str]:
    terms = []
    normalized = query.lower()
    for label, hints in _DOMAIN_HINTS.items():
        if any(hint.lower() in normalized for hint in hints):
            terms.append(label)
            for hint in hints:
                if hint.lower() in normalized:
                    terms.append(hint)
    return list(dict.fromkeys(terms))


def _append_unique(values: list[str], value: str):
    normalized = _normalize_query(value)
    if normalized and normalized not in values:
        values.append(normalized)


def plan_queries(query: str, max_queries: int = 3) -> list[str]:
    """Create deterministic retrieval queries for the first Agentic RAG pass."""
    original = _normalize_query(query)
    if not original:
        return []

    planned: list[str] = []
    _append_unique(planned, original)

    keywords = _keywords(original)
    exact_markers = sorted(extract_exact_markers(original))
    domain_terms = _domain_terms(original)

    if exact_markers or domain_terms:
        _append_unique(planned, " ".join(exact_markers + domain_terms + keywords[:6]))

    if keywords:
        _append_unique(planned, " ".join(keywords[:8]))

    if len(keywords) > 3:
        _append_unique(planned, " ".join(keywords[-8:]))

    return planned[:max(1, max_queries)]

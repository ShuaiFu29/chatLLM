import re


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


def _normalize_query(query: str) -> str:
    return re.sub(r"\s+", " ", query.strip())


def _keywords(query: str) -> list[str]:
    words = re.findall(r"[\w-]+", query.lower())
    return [word for word in words if len(word) > 2 and word not in _STOPWORDS]


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
    if keywords:
        _append_unique(planned, " ".join(keywords[:8]))

    if len(keywords) > 3:
        _append_unique(planned, " ".join(keywords[-8:]))

    return planned[:max(1, max_queries)]

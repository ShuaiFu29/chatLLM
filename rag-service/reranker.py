import re


def _tokens(value: str) -> set[str]:
    return {token.lower() for token in re.findall(r"[\w-]+", value) if len(token) > 2}


def _overlap(query: str, content: str) -> float:
    query_tokens = _tokens(query)
    if not query_tokens:
        return 0.0
    content_tokens = _tokens(content)
    if not content_tokens:
        return 0.0
    return len(query_tokens & content_tokens) / len(query_tokens)


def rerank_documents(query: str, documents: list[dict], top_k: int | None = None) -> list[dict]:
    ranked = []
    for index, document in enumerate(documents, start=1):
        retrieval_score = float(document.get("retrieval_score") or document.get("similarity") or 0)
        overlap_score = _overlap(query, str(document.get("content") or ""))
        rerank_score = round(retrieval_score * 0.35 + overlap_score * 0.65, 6)
        enriched = dict(document)
        enriched["pre_rerank_rank"] = index
        enriched["rerank_score"] = rerank_score
        enriched["reranker"] = "local-overlap"
        ranked.append(enriched)

    ranked.sort(key=lambda item: item["rerank_score"], reverse=True)
    return ranked[:top_k] if top_k else ranked

import time
import uuid
from typing import Callable

from evaluation import evaluate_retrieval_quality
from query_planner import plan_queries
from retrieval import retrieve_documents


RetrieveFn = Callable[[str, str, str | None, int, float], list[dict]]
RerankFn = Callable[[str, list[dict]], list[dict]]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _trace_step(step_type: str, status: str, started_at_ms: int, input_data: dict, output_data: dict) -> dict:
    return {
        "step_type": step_type,
        "status": status,
        "duration_ms": max(0, _now_ms() - started_at_ms),
        "input": input_data,
        "output": output_data,
    }


def _document_key(document: dict) -> str:
    metadata = document.get("metadata") or {}
    return str(
        document.get("id")
        or f"{metadata.get('file_id', '')}:{metadata.get('chunk_index', '')}"
        or document.get("content", "")
    )


def _query_overlap_score(query: str, content: str) -> float:
    query_terms = {term.lower() for term in query.replace("?", " ").replace(".", " ").split() if len(term) > 2}
    content_terms = {term.lower().strip(".,:;!?") for term in content.split() if len(term.strip(".,:;!?")) > 2}
    if not query_terms:
        return 0.0
    return len(query_terms & content_terms) / len(query_terms)


def default_rerank_documents(query: str, documents: list[dict]) -> list[dict]:
    ranked = []
    for document in documents:
        similarity = float(document.get("retrieval_score") or document.get("similarity") or 0)
        overlap = _query_overlap_score(query, str(document.get("content") or ""))
        document_with_score = dict(document)
        document_with_score["agentic_score"] = round(similarity * 0.7 + overlap * 0.3, 4)
        ranked.append(document_with_score)

    return sorted(ranked, key=lambda item: item.get("agentic_score", 0), reverse=True)


def _build_answer_guidance(quality: dict) -> tuple[bool, str]:
    insufficient_evidence = (
        quality.get("evidence_label") == "weak"
        or float(quality.get("overall_score") or 0) < 0.35
    )

    if not insufficient_evidence:
        return False, ""

    return True, (
        "Retrieved evidence is weak. Answer cautiously, state what is unsupported, "
        "and ask for more source material if the answer cannot be grounded."
    )


def agentic_retrieve(
    query: str,
    user_id: str,
    project_space_id: str | None = None,
    limit: int = 5,
    threshold: float = 0.1,
    retrieve_fn: RetrieveFn = retrieve_documents,
    rerank_fn: RerankFn = default_rerank_documents,
) -> dict:
    run_id = str(uuid.uuid4())
    trace_steps: list[dict] = []

    started_at = _now_ms()
    planned_queries = plan_queries(query, max_queries=3)
    trace_steps.append(_trace_step(
        "query_rewrite",
        "success",
        started_at,
        {"query": query, "max_queries": 3},
        {"planned_queries": planned_queries},
    ))

    merged_by_key: dict[str, dict] = {}
    retrieve_limit = min(max(limit * 2, limit), 20)
    for planned_query in planned_queries:
        started_at = _now_ms()
        documents = retrieve_fn(planned_query, user_id, project_space_id, retrieve_limit, threshold)
        trace_steps.append(_trace_step(
            "retrieve",
            "success",
            started_at,
            {"query": planned_query, "limit": retrieve_limit, "threshold": threshold},
            {
                "hit_count": len(documents),
                "top_similarity": max([float(doc.get("similarity") or 0) for doc in documents] or [0]),
            },
        ))

        for document in documents:
            key = _document_key(document)
            current = merged_by_key.get(key)
            if not current or float(document.get("similarity") or 0) > float(current.get("similarity") or 0):
                merged = dict(document)
                merged["matched_queries"] = sorted(set((current or {}).get("matched_queries", []) + [planned_query]))
                merged_by_key[key] = merged
            elif current:
                current["matched_queries"] = sorted(set(current.get("matched_queries", []) + [planned_query]))

    started_at = _now_ms()
    reranker_name = "default" if rerank_fn is default_rerank_documents else "custom"
    ranked_documents = rerank_fn(query, list(merged_by_key.values()))
    selected_documents = ranked_documents[:limit]
    trace_steps.append(_trace_step(
        "rerank",
        "success",
        started_at,
        {"candidate_count": len(ranked_documents), "limit": limit},
        {
            "reranker": reranker_name,
            "selected_count": len(selected_documents),
            "selected_ids": [document.get("id") for document in selected_documents],
        },
    ))

    started_at = _now_ms()
    quality = evaluate_retrieval_quality(query, selected_documents)
    insufficient_evidence, answer_guidance = _build_answer_guidance(quality)
    trace_steps.append(_trace_step(
        "evidence_check",
        "partial" if insufficient_evidence else "success",
        started_at,
        {"selected_count": len(selected_documents)},
        {**quality, "insufficient_evidence": insufficient_evidence},
    ))

    return {
        "run_id": run_id,
        "mode": "agentic",
        "planned_queries": planned_queries,
        "results": selected_documents,
        "trace_steps": trace_steps,
        "quality": quality,
        "insufficient_evidence": insufficient_evidence,
        "answer_guidance": answer_guidance,
    }

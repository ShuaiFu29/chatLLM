import json

from compatible_api import post_json
from config import settings


def _disabled(reason: str) -> dict:
    return {
        "enabled": False,
        "score": 0.0,
        "label": "disabled",
        "reasoning": reason,
    }


def _clamp_score(value: object) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, round(number, 4)))


def _safe_json(value: str) -> dict:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _compact_sources(documents: list[dict]) -> list[dict]:
    sources = []
    for index, document in enumerate(documents[:8], start=1):
        metadata = document.get("metadata") or {}
        sources.append({
            "rank": index,
            "filename": metadata.get("filename"),
            "chunk_index": metadata.get("chunk_index"),
            "content": str(document.get("content") or "")[:1200],
        })
    return sources


def evaluate_case_with_judge(case: dict, retrieval: dict, documents: list[dict]) -> dict:
    if not settings.rag_judge_enabled:
        return _disabled("RAG_JUDGE_ENABLED is false")

    if not settings.rag_judge_api_key:
        return _disabled("RAG_JUDGE_API_KEY is not configured")

    payload = {
        "question": str(case.get("question") or ""),
        "expected_answer": str(case.get("expected_answer") or ""),
        "expected_keywords": case.get("expected_keywords") or [],
        "expected_source_files": case.get("expected_source_files") or [],
        "retrieval_quality": retrieval.get("quality") or {},
        "sources": _compact_sources(documents),
    }
    response = post_json(
        settings.rag_judge_base_url,
        settings.rag_judge_api_key,
        "/chat/completions",
        {
            "model": settings.rag_judge_model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a strict RAG evaluation judge. Score whether the retrieved sources can support "
                        "the expected answer. Return JSON only with score number 0..1, label one of grounded/"
                        "partial/unsupported, and reasoning string. Penalize missing citations, unsupported claims, "
                        "and use of deprecated or FAQ-only sources when formal sources are required."
                    ),
                },
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        },
        settings.rag_judge_timeout_ms / 1000,
    )

    content = ((response.get("choices") or [{}])[0].get("message") or {}).get("content") or "{}"
    parsed = _safe_json(content)
    score = _clamp_score(parsed.get("score"))
    label = str(parsed.get("label") or ("grounded" if score >= 0.75 else "partial" if score >= 0.4 else "unsupported"))
    if label not in {"grounded", "partial", "unsupported"}:
        label = "partial"

    return {
        "enabled": True,
        "score": score,
        "label": label,
        "reasoning": str(parsed.get("reasoning") or "").strip()[:1000],
        "model": settings.rag_judge_model,
    }

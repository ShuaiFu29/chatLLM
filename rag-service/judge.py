import json
import math

from compatible_api import post_json
from config import settings

JUDGE_PROMPT_VERSION = "rag-judge-v2"


def _disabled(reason: str) -> dict:
    return {
        "enabled": False,
        "score": 0.0,
        "label": "disabled",
        "reasoning": reason,
        "correctness": 0.0,
        "completeness": 0.0,
        "faithfulness": 0.0,
        "judge_version": JUDGE_PROMPT_VERSION,
    }


def _validated_scores(payload: dict) -> tuple[float, float, float] | None:
    scores = []
    for field in ("correctness", "completeness", "faithfulness"):
        value = payload.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        number = float(value)
        if not math.isfinite(number) or number < 0 or number > 1:
            return None
        scores.append(round(number, 4))
    return scores[0], scores[1], scores[2]


def _safe_json(value: str) -> dict:
    try:
        parsed = json.loads(
            value,
            parse_constant=lambda constant: (_ for _ in ()).throw(
                ValueError(f"Invalid JSON constant: {constant}")
            ),
        )
    except (json.JSONDecodeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _compact_sources(documents: list[dict]) -> list[dict]:
    sources = []
    # The caller supplies the same token-budgeted documents used for answer
    # generation. Truncating them again would make faithfulness evaluation use
    # less evidence than the answer model actually saw.
    for index, document in enumerate(documents, start=1):
        metadata = document.get("metadata") or {}
        sources.append({
            "rank": index,
            "filename": metadata.get("filename"),
            "chunk_index": metadata.get("chunk_index"),
            "content": str(document.get("content") or ""),
        })
    return sources


def evaluate_case_with_judge(case: dict, retrieval: dict, documents: list[dict]) -> dict:
    actual_answer = str(retrieval.get("actual_answer") or case.get("actual_answer") or "").strip()
    if not actual_answer:
        return _disabled("Actual answer is unavailable; answer judging is not applicable")

    if not settings.rag_judge_enabled:
        return _disabled("RAG_JUDGE_ENABLED is false")

    if not settings.rag_judge_api_key:
        return _disabled("RAG_JUDGE_API_KEY is not configured")

    payload = {
        "question": str(case.get("question") or ""),
        "actual_answer": actual_answer,
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
                        "You are a strict RAG evaluation judge. Evaluate the actual answer, never the retrieved "
                        "documents as a substitute answer. Use the expected answer only as a reference. Return JSON "
                        "only with independent correctness, completeness, and faithfulness numbers from 0..1, plus "
                        "label one of grounded/partial/unsupported and a concise reasoning string. Correctness means "
                        "the claims answer the question accurately. Completeness means every explicit part of the "
                        "question is addressed. Faithfulness means claims and citations are supported by the supplied "
                        "sources, including exact numbers, dates, versions, conditions, and negation. Do not average "
                        "the dimensions into a composite score. Penalize reliance on deprecated sources."
                    ),
                },
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        },
        settings.rag_judge_timeout_ms / 1000,
    )

    content = ((response.get("choices") or [{}])[0].get("message") or {}).get("content") or "{}"
    parsed = _safe_json(content)
    scores = _validated_scores(parsed)
    if scores is None:
        return _disabled(
            "Judge response is unavailable because it did not contain valid numeric "
            "correctness, completeness, and faithfulness scores"
        )
    correctness, completeness, faithfulness = scores
    label = str(parsed.get("label") or ("grounded" if faithfulness >= 0.75 else "partial" if faithfulness >= 0.4 else "unsupported"))
    if label not in {"grounded", "partial", "unsupported"}:
        label = "partial"

    return {
        "enabled": True,
        # Compatibility only: the legacy judge score now aliases correctness,
        # while the three independent dimensions remain available below.
        "score": correctness,
        "correctness": correctness,
        "completeness": completeness,
        "faithfulness": faithfulness,
        "label": label,
        "reasoning": str(parsed.get("reasoning") or "").strip()[:1000],
        "model": settings.rag_judge_model,
        "judge_version": JUDGE_PROMPT_VERSION,
        "token_usage": response.get("usage") if isinstance(response.get("usage"), dict) else {},
    }

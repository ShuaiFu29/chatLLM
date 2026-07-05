import time
import re
from typing import Callable

from agentic_retrieval import agentic_retrieve


AgenticRetrieveFn = Callable[[str, str, str | None, int, float], dict]


def _normalize_expected_list(value) -> list[str]:
    if not value:
        return []
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _normalize_token(token: str) -> str:
    token = token.lower().strip()
    if len(token) > 4 and token.endswith("s"):
        token = token[:-1]
    return token


def _coverage_terms(value: str) -> set[str]:
    terms: set[str] = set()
    for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9-]*|[\u4e00-\u9fff]", value):
        normalized = _normalize_token(token)
        if len(normalized) > 2 or re.match(r"[\u4e00-\u9fff]", normalized):
            terms.add(normalized)
    return terms


def _score_expected_answer(expected_answer: str, documents: list[dict]) -> float:
    expected_terms = _coverage_terms(expected_answer)
    if not expected_terms:
        return 0.0

    combined_content = "\n".join(str(document.get("content") or "") for document in documents)
    content_terms = _coverage_terms(combined_content)
    if not content_terms:
        return 0.0

    return round(len(expected_terms & content_terms) / len(expected_terms), 4)


def _score_expected_keywords(expected_keywords: list[str], documents: list[dict]) -> float:
    if not expected_keywords:
        return 0.0

    combined_content = "\n".join(str(document.get("content") or "").lower() for document in documents)
    matches = 0
    for keyword in expected_keywords:
        if keyword.lower() in combined_content:
            matches += 1

    return round(matches / len(expected_keywords), 4)


def _source_names(documents: list[dict]) -> set[str]:
    names: set[str] = set()
    for document in documents:
        metadata = document.get("metadata") or {}
        filename = metadata.get("filename")
        file_id = metadata.get("file_id")
        if filename:
            names.add(str(filename).lower())
        if file_id:
            names.add(str(file_id).lower())
    return names


def _score_expected_sources(expected_source_files: list[str], documents: list[dict]) -> float:
    if not expected_source_files:
        return 0.0

    available_sources = _source_names(documents)
    matches = 0
    for expected_source in expected_source_files:
        if expected_source.lower() in available_sources:
            matches += 1

    return round(matches / len(expected_source_files), 4)


def _matched_sources(documents: list[dict]) -> list[dict]:
    sources = []
    for document in documents:
        metadata = document.get("metadata") or {}
        sources.append({
            "chunk_id": document.get("id"),
            "file_id": metadata.get("file_id"),
            "filename": metadata.get("filename"),
            "chunk_index": metadata.get("chunk_index"),
            "similarity": document.get("similarity", 0),
            "agentic_score": document.get("agentic_score", 0),
        })
    return sources


def _average(values: list[float]) -> float:
    if not values:
        return 0.0
    return round(sum(values) / len(values), 4)


def _weighted_score(components: list[tuple[float, float]]) -> float:
    total_weight = sum(weight for _, weight in components)
    if total_weight <= 0:
        return 0.0

    return round(sum(score * weight for score, weight in components) / total_weight, 4)


def run_eval_cases(
    cases: list[dict],
    user_id: str,
    project_space_id: str | None = None,
    limit: int = 10,
    threshold: float = 0.1,
    agentic_retrieve_fn: AgenticRetrieveFn = agentic_retrieve,
) -> dict:
    started_at = time.time()
    results = []

    for case in cases:
        case_id = str(case.get("id") or "")
        question = str(case.get("question") or "").strip()
        expected_answer = str(case.get("expected_answer") or "").strip()
        expected_keywords = _normalize_expected_list(case.get("expected_keywords"))
        expected_source_files = _normalize_expected_list(case.get("expected_source_files"))

        try:
            retrieval = agentic_retrieve_fn(question, user_id, project_space_id, limit, threshold)
            documents = retrieval.get("results") or []
            quality = retrieval.get("quality") or {}
            answer_score = _score_expected_answer(expected_answer, documents)
            keyword_score = _score_expected_keywords(expected_keywords, documents)
            source_score = _score_expected_sources(expected_source_files, documents)
            retrieval_score = float(quality.get("retrieval_score") or 0)
            evidence_score = float(quality.get("evidence_score") or 0)
            overall_components = [
                (retrieval_score, 0.30),
                (evidence_score, 0.20),
            ]
            if expected_answer:
                overall_components.append((answer_score, 0.20))
            if expected_keywords:
                overall_components.append((keyword_score, 0.15))
            if expected_source_files:
                overall_components.append((source_score, 0.15))
            overall_score = _weighted_score(overall_components)

            results.append({
                "case_id": case_id,
                "question": question,
                "status": "success",
                "overall_score": overall_score,
                "retrieval_score": retrieval_score,
                "answer_score": answer_score,
                "source_score": source_score,
                "keyword_score": keyword_score,
                "evidence_label": quality.get("evidence_label") or "weak",
                "matched_sources": _matched_sources(documents),
                "trace_summary": {
                    "run_id": retrieval.get("run_id"),
                    "mode": retrieval.get("mode"),
                    "planned_queries": retrieval.get("planned_queries") or [],
                    "trace_steps": retrieval.get("trace_steps") or [],
                    "quality": quality,
                },
                "error_message": "",
            })
        except Exception as error:
            results.append({
                "case_id": case_id,
                "question": question,
                "status": "failed",
                "overall_score": 0,
                "retrieval_score": 0,
                "answer_score": 0,
                "source_score": 0,
                "keyword_score": 0,
                "evidence_label": "weak",
                "matched_sources": [],
                "trace_summary": {},
                "error_message": str(error),
            })

    successful_results = [result for result in results if result["status"] == "success"]
    return {
        "case_count": len(cases),
        "failed_count": len(results) - len(successful_results),
        "duration_ms": int((time.time() - started_at) * 1000),
        "average_overall_score": _average([result["overall_score"] for result in successful_results]),
        "average_retrieval_score": _average([result["retrieval_score"] for result in successful_results]),
        "average_answer_score": _average([result["answer_score"] for result in successful_results]),
        "average_source_score": _average([result["source_score"] for result in successful_results]),
        "average_keyword_score": _average([result["keyword_score"] for result in successful_results]),
        "results": results,
    }

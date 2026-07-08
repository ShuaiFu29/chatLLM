import time
import re
from typing import Callable, Protocol

from agentic_retrieval import agentic_retrieve
from evidence_verifier import verify_evidence_support
from judge import evaluate_case_with_judge
from reranker import classify_source_role, extract_exact_markers


JudgeFn = Callable[[dict, dict, list[dict]], dict]


class AgenticRetrieveFn(Protocol):
    def __call__(
        self,
        query: str,
        user_id: str,
        project_space_id: str | None = None,
        *,
        limit: int = 10,
        threshold: float = 0.1,
    ) -> dict:
        ...


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


def _source_filenames(documents: list[dict]) -> set[str]:
    names: set[str] = set()
    for document in documents:
        metadata = document.get("metadata") or {}
        filename = metadata.get("filename")
        if filename:
            names.add(str(filename).lower())
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


def _score_source_precision(expected_source_files: list[str], documents: list[dict]) -> float:
    if not expected_source_files or not documents:
        return 0.0

    expected_sources = {source.lower() for source in expected_source_files}
    retrieved_sources = _source_filenames(documents)
    if not retrieved_sources:
        return 0.0

    matches = len(expected_sources & retrieved_sources)
    return round(matches / len(retrieved_sources), 4)


def _score_citation_accuracy(documents: list[dict]) -> float:
    if not documents:
        return 0.0

    valid_count = 0
    for document in documents:
        metadata = document.get("metadata") or {}
        if metadata.get("file_id") and metadata.get("filename") and metadata.get("chunk_index") is not None:
            valid_count += 1

    return round(valid_count / len(documents), 4)


_NEGATED_OR_DEPRECATED_TERMS = (
    "废止",
    "已废止",
    "失效",
    "旧口径",
    "历史口径",
    "不能替代",
    "不得",
    "不是",
    "不应",
    "不可",
    "deprecated",
    "obsolete",
    "historical",
    "superseded",
    "not ",
    "not-",
    "cannot",
    "must not",
)


def _marker_contexts(value: str, marker: str, window: int = 36) -> list[str]:
    contexts: list[str] = []
    if not value or not marker:
        return contexts

    marker_pattern = re.escape(marker)
    for match in re.finditer(marker_pattern, value, flags=re.IGNORECASE):
        start = max(0, match.start() - window)
        end = min(len(value), match.end() + window)
        contexts.append(value[start:end].lower())
    return contexts


def _context_is_negated_or_deprecated(context: str) -> bool:
    normalized = context.lower().replace(" ", "")
    return any(term.lower().replace(" ", "") in normalized for term in _NEGATED_OR_DEPRECATED_TERMS)


def _asserted_answer_markers(expected_answer: str) -> set[str]:
    markers = extract_exact_markers(expected_answer)
    asserted = set()
    for marker in markers:
        contexts = _marker_contexts(expected_answer, marker)
        if contexts and all(_context_is_negated_or_deprecated(context) for context in contexts):
            continue
        asserted.add(marker)
    return asserted


def _deprecated_marker_conflicts(expected_answer: str, documents: list[dict]) -> list[str]:
    asserted_markers = _asserted_answer_markers(expected_answer)
    if not asserted_markers:
        return []

    conflicts: set[str] = set()
    primary_support: set[str] = set()
    for document in documents:
        content = str(document.get("content") or "")
        role = document.get("source_role") or classify_source_role(document)
        content_markers = extract_exact_markers(content)
        for marker in asserted_markers & content_markers:
            contexts = _marker_contexts(content, marker)
            if role == "deprecated" or any(_context_is_negated_or_deprecated(context) for context in contexts):
                conflicts.add(marker)
            elif role not in {"evaluation_guide", "deprecated"}:
                primary_support.add(marker)

    return sorted(conflicts - primary_support)


def _verify_expected_answer_support(expected_answer: str, documents: list[dict]) -> dict:
    if not expected_answer:
        return {
            "support_label": "not_applicable",
            "support_score": 1.0,
            "reasons": ["no_expected_answer"],
            "deprecated_marker_conflicts": [],
        }

    verification = verify_evidence_support(expected_answer, documents)
    conflicts = _deprecated_marker_conflicts(expected_answer, documents)
    if conflicts:
        reasons = sorted(set((verification.get("reasons") or []) + ["deprecated_marker_conflict"]))
        return {
            **verification,
            "support_label": "unsupported",
            "support_score": min(float(verification.get("support_score") or 0), 0.25),
            "deprecated_marker_conflicts": conflicts,
            "reasons": reasons,
        }

    return {
        **verification,
        "deprecated_marker_conflicts": [],
    }


def _score_grounding(
    answer_score: float,
    keyword_score: float,
    source_recall_score: float,
    citation_accuracy_score: float,
    expected_answer_support_score: float,
    expected_answer_support_label: str,
    judge_score: float,
    judge_enabled: bool,
) -> float:
    components = [
        (answer_score, 0.20),
        (keyword_score, 0.20),
        (source_recall_score, 0.20),
        (citation_accuracy_score, 0.15),
        (expected_answer_support_score, 0.25),
    ]
    if judge_enabled:
        components.append((judge_score, 0.30))
    score = _weighted_score(components)
    if expected_answer_support_label == "unsupported":
        return min(score, 0.45)
    if expected_answer_support_label == "partial":
        return min(score, 0.72)
    return score


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
    judge_fn: JudgeFn | None = evaluate_case_with_judge,
) -> dict:
    started_at = time.time()
    results = []

    for case in cases:
        case_started_at = time.time()
        case_id = str(case.get("id") or "")
        question = str(case.get("question") or "").strip()
        expected_answer = str(case.get("expected_answer") or "").strip()
        expected_keywords = _normalize_expected_list(case.get("expected_keywords"))
        expected_source_files = _normalize_expected_list(case.get("expected_source_files"))

        try:
            retrieval = agentic_retrieve_fn(
                question,
                user_id,
                project_space_id=project_space_id,
                limit=limit,
                threshold=threshold,
            )
            documents = retrieval.get("results") or []
            quality = retrieval.get("quality") or {}
            answer_score = _score_expected_answer(expected_answer, documents)
            keyword_score = _score_expected_keywords(expected_keywords, documents)
            source_score = _score_expected_sources(expected_source_files, documents)
            source_recall_score = source_score
            source_precision_score = _score_source_precision(expected_source_files, documents)
            citation_accuracy_score = _score_citation_accuracy(documents)
            expected_answer_verification = _verify_expected_answer_support(expected_answer, documents)
            expected_answer_support_score = float(expected_answer_verification.get("support_score") or 0)
            expected_answer_support_label = str(expected_answer_verification.get("support_label") or "unsupported")
            retrieval_score = float(quality.get("retrieval_score") or 0)
            evidence_score = float(quality.get("evidence_score") or 0)
            verification_score = float(quality.get("verification_score") or 0)
            judge = judge_fn(case, retrieval, documents) if judge_fn else {"enabled": False, "score": 0.0}
            judge_score = float(judge.get("score") or 0)
            grounding_score = _score_grounding(
                answer_score,
                keyword_score,
                source_recall_score,
                citation_accuracy_score,
                expected_answer_support_score,
                expected_answer_support_label,
                judge_score,
                bool(judge.get("enabled")),
            )
            overall_components = [
                (retrieval_score, 0.30),
                (evidence_score, 0.20),
            ]
            if "verification_score" in quality:
                overall_components.append((verification_score, 0.20))
            if expected_answer:
                overall_components.append((expected_answer_support_score, 0.20))
            if expected_answer:
                overall_components.append((answer_score, 0.20))
            if expected_keywords:
                overall_components.append((keyword_score, 0.15))
            if expected_source_files:
                overall_components.append((source_score, 0.15))
            if judge.get("enabled"):
                overall_components.append((judge_score, 0.30))
            overall_score = _weighted_score(overall_components)

            results.append({
                "case_id": case_id,
                "question": question,
                "status": "success",
                "overall_score": overall_score,
                "retrieval_score": retrieval_score,
                "answer_score": answer_score,
                "source_score": source_score,
                "source_recall_score": source_recall_score,
                "source_precision_score": source_precision_score,
                "citation_accuracy_score": citation_accuracy_score,
                "keyword_score": keyword_score,
                "answer_keyword_score": keyword_score,
                "grounding_score": grounding_score,
                "judge_score": judge_score,
                "expected_answer_support_score": expected_answer_support_score,
                "expected_answer_support_label": expected_answer_support_label,
                "evidence_label": quality.get("evidence_label") or "weak",
                "support_label": quality.get("support_label") or "unsupported",
                "verification_score": verification_score,
                "risk_level": quality.get("risk_level") or "low",
                "matched_sources": _matched_sources(documents),
                "latency_ms": int((time.time() - case_started_at) * 1000),
                "trace_summary": {
                    "run_id": retrieval.get("run_id"),
                    "mode": retrieval.get("mode"),
                    "planned_queries": retrieval.get("planned_queries") or [],
                    "trace_steps": retrieval.get("trace_steps") or [],
                    "quality": quality,
                    "expected_answer_verification": expected_answer_verification,
                    "judge": judge,
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
                "source_recall_score": 0,
                "source_precision_score": 0,
                "citation_accuracy_score": 0,
                "keyword_score": 0,
                "answer_keyword_score": 0,
                "grounding_score": 0,
                "judge_score": 0,
                "expected_answer_support_score": 0,
                "expected_answer_support_label": "unsupported",
                "evidence_label": "weak",
                "support_label": "unsupported",
                "verification_score": 0,
                "risk_level": "unknown",
                "matched_sources": [],
                "latency_ms": int((time.time() - case_started_at) * 1000),
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
        "average_source_recall_score": _average([result["source_recall_score"] for result in successful_results]),
        "average_source_precision_score": _average([result["source_precision_score"] for result in successful_results]),
        "average_citation_accuracy_score": _average([result["citation_accuracy_score"] for result in successful_results]),
        "average_keyword_score": _average([result["keyword_score"] for result in successful_results]),
        "average_answer_keyword_score": _average([result["answer_keyword_score"] for result in successful_results]),
        "average_grounding_score": _average([result["grounding_score"] for result in successful_results]),
        "average_judge_score": _average([result["judge_score"] for result in successful_results]),
        "average_expected_answer_support_score": _average([result["expected_answer_support_score"] for result in successful_results]),
        "average_verification_score": _average([result["verification_score"] for result in successful_results]),
        "results": results,
    }

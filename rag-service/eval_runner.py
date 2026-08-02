import time
import re
import random
from typing import Callable, Protocol

from agentic_retrieval import agentic_retrieve
from db import assert_eval_lease_active
from evaluation import (
    evaluate_gold_chunk_quality,
    evaluate_gold_evidence_quality,
    evaluate_gold_graph_quality,
    evaluate_gold_retrieval_quality,
)
from evidence_verifier import verify_evidence_support
from judge import evaluate_case_with_judge
from reranker import classify_source_role, extract_exact_markers


JudgeFn = Callable[[dict, dict, list[dict]], dict]
LeaseAssertFn = Callable[[str, str], None]
BENCHMARK_TYPE = "retrieval_evidence"


class EvalExecutionStopped(RuntimeError):
    """Raised when cancellation or lease replacement stops an evaluation."""


class EvalRunDeadlineExceeded(TimeoutError):
    """Raised when the whole evaluation run has reached its deadline."""


class EvalCaseDeadlineExceeded(TimeoutError):
    """Raised when one evaluation case has reached its deadline."""


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


def _assert_eval_execution_active(
    *,
    run_id: str | None,
    lease_token: str | None,
    deadline_at: float | None,
    case_deadline_at: float | None,
    assert_lease_fn: LeaseAssertFn,
    now_fn: Callable[[], float],
):
    if run_id and lease_token:
        try:
            assert_lease_fn(run_id, lease_token)
        except Exception as error:
            raise EvalExecutionStopped(str(error)) from error

    now = now_fn()
    if deadline_at is not None and now >= deadline_at:
        raise EvalRunDeadlineExceeded("Evaluation run deadline exceeded")
    if case_deadline_at is not None and now >= case_deadline_at:
        raise EvalCaseDeadlineExceeded("Evaluation case deadline exceeded")


def _normalize_expected_list(value) -> list[str]:
    if not value:
        return []
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _normalize_evaluation_spec(value) -> dict:
    return dict(value) if isinstance(value, dict) else {}


def _normalize_graph_expectations(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, dict)]


def _numeric_usage(value) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    output: dict[str, int] = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        try:
            number = int(value.get(key) or 0)
        except (TypeError, ValueError):
            continue
        if number >= 0:
            output[key] = number
    if "total_tokens" not in value and ("prompt_tokens" in output or "completion_tokens" in output):
        output["total_tokens"] = output.get("prompt_tokens", 0) + output.get("completion_tokens", 0)
    return output


def _judge_human_calibration(judge: dict, human_scores: object, tolerance: float = 0.15) -> dict:
    if not judge.get("enabled") or not isinstance(human_scores, dict):
        return {"applicable": False, "reason": "judge_or_human_scores_unavailable"}
    differences = {}
    for dimension in ("correctness", "completeness", "faithfulness"):
        human = human_scores.get(dimension)
        judged = judge.get(dimension)
        if isinstance(human, bool) or not isinstance(human, (int, float)):
            continue
        if isinstance(judged, bool) or not isinstance(judged, (int, float)):
            continue
        if 0 <= float(human) <= 1:
            differences[dimension] = round(abs(float(judged) - float(human)), 4)
    if not differences:
        return {"applicable": False, "reason": "no_comparable_human_scores"}
    mae = round(sum(differences.values()) / len(differences), 4)
    agreement = round(
        len([value for value in differences.values() if value <= tolerance]) / len(differences),
        4,
    )
    return {
        "applicable": True,
        "tolerance": tolerance,
        "absolute_errors": differences,
        "mae": mae,
        "agreement_rate": agreement,
    }


def _answerability_metrics(expected_answerable: object, answer_evaluation: dict, actual_answer: str) -> dict:
    if not isinstance(expected_answerable, bool):
        return {"applicable": False, "reason": "answerability_not_labeled"}
    if not actual_answer:
        return {"applicable": False, "reason": "actual_answer_unavailable"}
    abstained = bool(answer_evaluation.get("abstained"))
    predicted_answerable = not abstained
    return {
        "applicable": True,
        "expected_answerable": expected_answerable,
        "predicted_answerable": predicted_answerable,
        "abstained": abstained,
        "accuracy": 1.0 if predicted_answerable == expected_answerable else 0.0,
        "false_answer": 1.0 if not expected_answerable and predicted_answerable else 0.0,
        "false_abstention": 1.0 if expected_answerable and abstained else 0.0,
    }


def _percentile(values: list[int], percentile: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return int(round(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction))


def _float_percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 4)
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction, 4)


def _bootstrap_mean_ci(values: list[float], iterations: int = 1000) -> dict:
    normalized = [float(value) for value in values if isinstance(value, (int, float)) and not isinstance(value, bool)]
    if not normalized:
        return {"applicable": False, "reason": "no_applicable_cases"}
    mean = round(sum(normalized) / len(normalized), 4)
    if len(normalized) == 1:
        lower = upper = mean
    else:
        rng = random.Random(1729 + len(normalized))
        bootstrap_means = [
            sum(rng.choice(normalized) for _ in normalized) / len(normalized)
            for _ in range(iterations)
        ]
        lower = _float_percentile(bootstrap_means, 0.025)
        upper = _float_percentile(bootstrap_means, 0.975)
    return {
        "applicable": True,
        "method": "deterministic_bootstrap",
        "confidence_level": 0.95,
        "iterations": iterations,
        "case_count": len(normalized),
        "mean": mean,
        "lower": lower,
        "upper": upper,
    }


def _evaluation_slice(spec: dict) -> dict:
    tags = spec.get("tags") if isinstance(spec.get("tags"), list) else []
    return {
        "tags": sorted({str(tag).strip() for tag in tags if str(tag).strip()}),
        "category": str(spec.get("category") or "").strip() or None,
        "difficulty": str(spec.get("difficulty") or "").strip() or None,
        "expected_answerable": spec.get("expected_answerable")
        if isinstance(spec.get("expected_answerable"), bool) else None,
    }


def _aggregate_slices(results: list[dict]) -> list[dict]:
    grouped: dict[str, list[dict]] = {}
    for result in results:
        slice_info = ((result.get("advanced_metrics") or {}).get("slice") or {})
        dimensions = [f"tag:{tag}" for tag in slice_info.get("tags") or []]
        for name in ("category", "difficulty"):
            if slice_info.get(name):
                dimensions.append(f"{name}:{slice_info[name]}")
        if isinstance(slice_info.get("expected_answerable"), bool):
            dimensions.append(
                "answerability:answerable" if slice_info["expected_answerable"]
                else "answerability:unanswerable"
            )
        for dimension in dimensions:
            grouped.setdefault(dimension, []).append(result)

    output = []
    for dimension, items in sorted(grouped.items()):
        applicable = lambda item, metric: bool((item.get("metric_applicability") or {}).get(metric))
        retrieval = [float(item["retrieval_score"]) for item in items if applicable(item, "retrieval")]
        answers = [float(item["answer_score"]) for item in items if applicable(item, "answer")]
        grounding = [float(item["grounding_score"]) for item in items if applicable(item, "faithfulness")]
        output.append({
            "slice": dimension,
            "case_count": len(items),
            "successful_case_count": len([item for item in items if item.get("status") == "success"]),
            "average_retrieval_score": _average(retrieval) if retrieval else None,
            "average_answer_score": _average(answers) if answers else None,
            "average_grounding_score": _average(grounding) if grounding else None,
            "retrieval_confidence_interval": _bootstrap_mean_ci(retrieval),
        })
    return output


def _average_applicable(results: list[dict], path: tuple[str, ...]) -> float | None:
    values = []
    for result in results:
        advanced = result.get("advanced_metrics") or {}
        group = advanced.get(path[0]) if isinstance(advanced, dict) and path else None
        if not isinstance(group, dict) or group.get("applicable") is not True:
            continue
        value: object = advanced
        for key in path:
            value = value.get(key) if isinstance(value, dict) else None
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            values.append(float(value))
    # An absent gold label is not a failed prediction. Keep the aggregate
    # value explicitly unavailable instead of emitting a misleading zero.
    return _average(values) if values else None


def _aggregate_advanced_metrics(results: list[dict]) -> dict:
    latencies = [int(result.get("latency_ms") or 0) for result in results]
    answer_usage = {key: 0 for key in ("prompt_tokens", "completion_tokens", "total_tokens")}
    judge_usage = {key: 0 for key in ("prompt_tokens", "completion_tokens", "total_tokens")}
    for result in results:
        token_usage = (result.get("advanced_metrics") or {}).get("token_usage") or {}
        for target, source in (
            (answer_usage, token_usage.get("answer") or {}),
            (judge_usage, token_usage.get("judge") or {}),
        ):
            for key in target:
                target[key] += int(source.get(key) or 0)
    applicable_count = lambda name: len([
        result for result in results
        if ((result.get("advanced_metrics") or {}).get(name) or {}).get("applicable") is True
    ])
    chunk_count = applicable_count("chunk_retrieval")
    evidence_count = applicable_count("evidence_retrieval")
    graph_count = applicable_count("graph_retrieval")
    answerability_count = applicable_count("answerability")
    calibration_count = applicable_count("judge_human_calibration")
    usage_applicable = bool(answer_usage["total_tokens"] or judge_usage["total_tokens"])
    applicable = lambda result, metric: bool((result.get("metric_applicability") or {}).get(metric))
    return {
        "latency_ms": {
            "applicable": bool(results),
            "p50": _percentile(latencies, 0.50),
            "p95": _percentile(latencies, 0.95),
            "max": max(latencies or [0]),
        },
        "chunk_retrieval": {
            "applicable": chunk_count > 0,
            "case_count": chunk_count,
            "average_recall_at_k": _average_applicable(results, ("chunk_retrieval", "recall_at_k")),
            "average_mrr_at_k": _average_applicable(results, ("chunk_retrieval", "mrr_at_k")),
        },
        "evidence_retrieval": {
            "applicable": evidence_count > 0,
            "case_count": evidence_count,
            "average_recall_at_k": _average_applicable(results, ("evidence_retrieval", "recall_at_k")),
            "average_mrr_at_k": _average_applicable(results, ("evidence_retrieval", "mrr_at_k")),
        },
        "graph_retrieval": {
            "applicable": graph_count > 0,
            "case_count": graph_count,
            "average_recall_at_k": _average_applicable(results, ("graph_retrieval", "recall_at_k")),
            "average_precision_at_k": _average_applicable(results, ("graph_retrieval", "precision_at_k")),
            "average_endpoint_only_recall_at_k": _average_applicable(
                results, ("graph_retrieval", "endpoint_only", "recall_at_k"),
            ),
            "average_endpoint_only_precision_at_k": _average_applicable(
                results, ("graph_retrieval", "endpoint_only", "precision_at_k"),
            ),
        },
        "answerability": {
            "applicable": answerability_count > 0,
            "case_count": answerability_count,
            "accuracy": _average_applicable(results, ("answerability", "accuracy")),
            "false_answer_rate": _average_applicable(results, ("answerability", "false_answer")),
            "false_abstention_rate": _average_applicable(results, ("answerability", "false_abstention")),
        },
        "judge_human_calibration": {
            "applicable": calibration_count > 0,
            "case_count": calibration_count,
            "mae": _average_applicable(results, ("judge_human_calibration", "mae")),
            "agreement_rate": _average_applicable(results, ("judge_human_calibration", "agreement_rate")),
        },
        "token_usage": {"applicable": usage_applicable, "answer": answer_usage, "judge": judge_usage},
        "confidence_intervals": {
            "retrieval_score": _bootstrap_mean_ci([
                float(result["retrieval_score"]) for result in results if applicable(result, "retrieval")
            ]),
            "answer_score": _bootstrap_mean_ci([
                float(result["answer_score"]) for result in results if applicable(result, "answer")
            ]),
            "grounding_score": _bootstrap_mean_ci([
                float(result["grounding_score"]) for result in results if applicable(result, "faithfulness")
            ]),
        },
        "slices": _aggregate_slices(results),
        "cost": {
            "applicable": False,
            "reason": "provider pricing is not configured; token usage is reported without fabricated currency cost",
        },
    }


def _score_expected_keywords(expected_keywords: list[str], documents: list[dict]) -> float:
    if not expected_keywords:
        return 0.0

    combined_content = "\n".join(str(document.get("content") or "").casefold() for document in documents)
    matches = 0
    for keyword in expected_keywords:
        normalized_keyword = keyword.strip().casefold()
        if not normalized_keyword:
            continue
        if re.search(r"[\u3400-\u9fff]", normalized_keyword):
            matched = normalized_keyword in combined_content
        else:
            phrase_pattern = r"\s+".join(
                re.escape(part)
                for part in re.split(r"\s+", normalized_keyword)
                if part
            )
            matched = bool(re.search(
                rf"(?<![a-z0-9_]){phrase_pattern}(?![a-z0-9_])",
                combined_content,
                flags=re.IGNORECASE,
            ))
        if matched:
            matches += 1

    return round(matches / len(expected_keywords), 4)


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


def _failed_case_result(
    case_id: str,
    question: str,
    case_started_at: float,
    now_fn: Callable[[], float],
    error_message: str,
    expected_source_files: list[str] | None = None,
    expected_answer: str = "",
    expected_keywords: list[str] | None = None,
    evaluation_spec: dict | None = None,
) -> dict:
    retrieval_applicable = bool(expected_source_files)
    spec = _normalize_evaluation_spec(evaluation_spec)
    advanced_metrics = {
        "chunk_retrieval": evaluate_gold_chunk_quality(
            _normalize_expected_list(spec.get("expected_chunk_ids")), [], k=5,
        ),
        "evidence_retrieval": evaluate_gold_evidence_quality(
            _normalize_expected_list(spec.get("expected_evidence")), [], k=5,
        ),
        "graph_retrieval": evaluate_gold_graph_quality(
            _normalize_graph_expectations(spec.get("expected_graph_relations")), [], k=5,
        ),
        "answerability": {"applicable": False, "reason": "actual_answer_unavailable"},
        "judge_human_calibration": {"applicable": False, "reason": "judge_unavailable"},
        "token_usage": {"answer": {}, "judge": {}},
        "slice": _evaluation_slice(spec),
    }
    advanced_applicability = {
        "chunk_retrieval": advanced_metrics["chunk_retrieval"]["applicable"],
        "evidence_retrieval": advanced_metrics["evidence_retrieval"]["applicable"],
        "graph_retrieval": advanced_metrics["graph_retrieval"]["applicable"],
        "answerability": False,
        "judge_calibration": False,
    }
    return {
        "benchmark_type": BENCHMARK_TYPE,
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
        "answer_keyword_score": None,
        "grounding_score": 0,
        "judge_score": 0,
        "actual_answer": "",
        "correctness_score": 0,
        "completeness_score": 0,
        "faithfulness_score": 0,
        "citation_precision": 0,
        "citation_coverage": 0,
        "citation_f1": 0,
        "hallucination_rate": 0,
        "prompt_version": "",
        "model_version": "",
        "judge_version": "",
        "verifier_version": "",
        "claim_evaluation": {},
        "expected_answer_support_score": 0,
        "expected_answer_support_label": "unsupported",
        "evidence_label": "weak",
        "support_label": "unsupported",
        "verification_score": 0,
        "risk_level": "unknown",
        "retrieval_recall_at_k": 0,
        "retrieval_mrr_at_k": 0,
        "retrieval_k": 5,
        "metric_applicability": {
            "retrieval": retrieval_applicable,
            "answer": False,
            "faithfulness": False,
            "correctness": False,
            "completeness": False,
            "judge_faithfulness": False,
            "citation_precision": False,
            "citation_coverage": False,
            "citation_f1": False,
            "hallucination_rate": False,
            "overall": retrieval_applicable,
            "expected_answer_support": bool(expected_answer),
            "keyword_retrieval": bool(expected_keywords),
            **advanced_applicability,
        },
        "matched_sources": [],
        "latency_ms": int((now_fn() - case_started_at) * 1000),
        "trace_summary": {
            "benchmark_type": BENCHMARK_TYPE,
            "metric_applicability": {
                "retrieval": retrieval_applicable,
                "answer": False,
                "faithfulness": False,
                "correctness": False,
                "completeness": False,
                "judge_faithfulness": False,
                "citation_precision": False,
                "citation_coverage": False,
                "citation_f1": False,
                "hallucination_rate": False,
                "overall": retrieval_applicable,
                "expected_answer_support": bool(expected_answer),
                "keyword_retrieval": bool(expected_keywords),
                **advanced_applicability,
            },
            "advanced_metrics": advanced_metrics,
        },
        "advanced_metrics": advanced_metrics,
        "error_message": error_message,
    }


def run_eval_cases(
    cases: list[dict],
    user_id: str,
    project_space_id: str | None = None,
    limit: int = 10,
    threshold: float = 0.1,
    agentic_retrieve_fn: AgenticRetrieveFn = agentic_retrieve,
    judge_fn: JudgeFn | None = evaluate_case_with_judge,
    run_id: str | None = None,
    lease_token: str | None = None,
    deadline_at: float | None = None,
    case_timeout_ms: int = 60000,
    assert_lease_fn: LeaseAssertFn = assert_eval_lease_active,
    now_fn: Callable[[], float] = time.time,
) -> dict:
    if bool(run_id) != bool(lease_token):
        raise ValueError("run_id and lease_token must be provided together")
    if case_timeout_ms <= 0:
        raise ValueError("case_timeout_ms must be positive")

    started_at = now_fn()
    results = []

    _assert_eval_execution_active(
        run_id=run_id,
        lease_token=lease_token,
        deadline_at=deadline_at,
        case_deadline_at=None,
        assert_lease_fn=assert_lease_fn,
        now_fn=now_fn,
    )

    for case in cases:
        case_started_at = now_fn()
        case_deadline_at = case_started_at + (case_timeout_ms / 1000)
        case_id = str(case.get("id") or "")
        question = str(case.get("question") or "").strip()
        expected_answer = str(case.get("expected_answer") or "").strip()
        expected_keywords = _normalize_expected_list(case.get("expected_keywords"))
        expected_source_files = _normalize_expected_list(case.get("expected_source_files"))
        evaluation_spec = _normalize_evaluation_spec(case.get("evaluation_spec"))

        preparation_error = str(case.get("preparation_error") or "").strip()
        if preparation_error:
            results.append(_failed_case_result(
                case_id,
                question,
                case_started_at,
                now_fn,
                preparation_error,
                expected_source_files,
                expected_answer,
                expected_keywords,
                evaluation_spec,
            ))
            continue

        try:
            _assert_eval_execution_active(
                run_id=run_id,
                lease_token=lease_token,
                deadline_at=deadline_at,
                case_deadline_at=case_deadline_at,
                assert_lease_fn=assert_lease_fn,
                now_fn=now_fn,
            )
            retrieval_snapshot = case.get("retrieval_snapshot")
            if isinstance(retrieval_snapshot, dict) and retrieval_snapshot:
                retrieval = retrieval_snapshot
            else:
                retrieval = agentic_retrieve_fn(
                    question,
                    user_id,
                    project_space_id=project_space_id,
                    limit=limit,
                    threshold=threshold,
                )
            _assert_eval_execution_active(
                run_id=run_id,
                lease_token=lease_token,
                deadline_at=deadline_at,
                case_deadline_at=case_deadline_at,
                assert_lease_fn=assert_lease_fn,
                now_fn=now_fn,
            )
            documents = retrieval.get("results") or []
            answer_sources = retrieval.get("answer_sources") or documents
            quality = retrieval.get("quality") or {}
            gold_retrieval = evaluate_gold_retrieval_quality(
                expected_source_files,
                documents,
                k=min(5, max(1, limit)),
            )
            retrieval_k = min(5, max(1, limit))
            chunk_retrieval = evaluate_gold_chunk_quality(
                _normalize_expected_list(evaluation_spec.get("expected_chunk_ids")),
                documents,
                k=retrieval_k,
            )
            evidence_retrieval = evaluate_gold_evidence_quality(
                _normalize_expected_list(evaluation_spec.get("expected_evidence")),
                documents,
                k=retrieval_k,
            )
            graph_retrieval = evaluate_gold_graph_quality(
                _normalize_graph_expectations(evaluation_spec.get("expected_graph_relations")),
                documents,
                k=retrieval_k,
            )
            retrieval_score = float(gold_retrieval["retrieval_score"])
            source_score = float(gold_retrieval["recall_at_k"])
            source_recall_score = source_score
            source_precision_score = float(gold_retrieval["source_precision_at_k"])
            keyword_score = _score_expected_keywords(expected_keywords, documents)
            answer_evaluation = case.get("answer_evaluation")
            if not isinstance(answer_evaluation, dict):
                answer_evaluation = {}
            claim_applicability = answer_evaluation.get("metric_applicability")
            if not isinstance(claim_applicability, dict):
                claim_applicability = {}
            citation_precision = float(answer_evaluation.get("citation_precision") or 0)
            citation_coverage = float(answer_evaluation.get("citation_coverage") or 0)
            citation_f1 = float(answer_evaluation.get("citation_f1") or 0)
            hallucination_rate = float(answer_evaluation.get("hallucination_rate") or 0)
            citation_accuracy_score = citation_precision
            expected_answer_verification = _verify_expected_answer_support(expected_answer, documents)
            expected_answer_support_score = float(expected_answer_verification.get("support_score") or 0)
            expected_answer_support_label = str(expected_answer_verification.get("support_label") or "unsupported")
            verification_score = float(quality.get("verification_score") or 0)
            actual_answer = str(case.get("actual_answer") or retrieval.get("actual_answer") or "").strip()
            if judge_fn and actual_answer:
                _assert_eval_execution_active(
                    run_id=run_id,
                    lease_token=lease_token,
                    deadline_at=deadline_at,
                    case_deadline_at=case_deadline_at,
                    assert_lease_fn=assert_lease_fn,
                    now_fn=now_fn,
                )
                judge = judge_fn(case, retrieval, answer_sources)
                _assert_eval_execution_active(
                    run_id=run_id,
                    lease_token=lease_token,
                    deadline_at=deadline_at,
                    case_deadline_at=case_deadline_at,
                    assert_lease_fn=assert_lease_fn,
                    now_fn=now_fn,
                )
            else:
                judge = {
                    "enabled": False,
                    "score": 0.0,
                    "label": "disabled",
                    "reasoning": "Actual answer is unavailable; answer metrics are not applicable",
                }
            answerability = _answerability_metrics(
                evaluation_spec.get("expected_answerable"),
                answer_evaluation,
                actual_answer,
            )
            judge_calibration = _judge_human_calibration(
                judge,
                evaluation_spec.get("human_scores"),
            )
            generation_metadata = case.get("generation_metadata")
            if not isinstance(generation_metadata, dict):
                generation_metadata = {}
            advanced_metrics = {
                "chunk_retrieval": chunk_retrieval,
                "evidence_retrieval": evidence_retrieval,
                "graph_retrieval": graph_retrieval,
                "answerability": answerability,
                "judge_human_calibration": judge_calibration,
                "token_usage": {
                    "answer": _numeric_usage(generation_metadata.get("token_usage")),
                    "judge": _numeric_usage(judge.get("token_usage")),
                },
                "slice": _evaluation_slice(evaluation_spec),
            }
            correctness_score = float(judge.get("correctness", judge.get("score")) or 0)
            completeness_score = float(judge.get("completeness", judge.get("score")) or 0)
            faithfulness_score = float(judge.get("faithfulness") or 0)
            judge_score = correctness_score
            answer_applicable = bool(actual_answer and judge.get("enabled"))
            faithfulness_applicable = bool(
                actual_answer
                and claim_applicability.get("claim_verification")
            )
            answer_score = correctness_score if answer_applicable else 0.0
            answer_keyword_score = None
            grounding_score = 1.0 - hallucination_rate if faithfulness_applicable else 0.0
            metric_applicability = {
                "retrieval": bool(gold_retrieval["applicable"]),
                "answer": answer_applicable,
                "faithfulness": faithfulness_applicable,
                "correctness": answer_applicable,
                "completeness": answer_applicable,
                "judge_faithfulness": answer_applicable,
                "citation_precision": bool(claim_applicability.get("citation_precision")),
                "citation_coverage": bool(claim_applicability.get("citation_coverage")),
                "citation_f1": bool(claim_applicability.get("citation_f1")),
                "hallucination_rate": bool(claim_applicability.get("hallucination_rate")),
                "overall": bool(gold_retrieval["applicable"]),
                "expected_answer_support": bool(expected_answer),
                "keyword_retrieval": bool(expected_keywords),
                "chunk_retrieval": bool(chunk_retrieval["applicable"]),
                "evidence_retrieval": bool(evidence_retrieval["applicable"]),
                "graph_retrieval": bool(graph_retrieval["applicable"]),
                "answerability": bool(answerability["applicable"]),
                "judge_calibration": bool(judge_calibration["applicable"]),
            }
            # This is a retrieval/evidence benchmark. The persisted compatibility
            # column is the gold retrieval score, never a synthetic answer blend.
            overall_score = retrieval_score if metric_applicability["retrieval"] else 0.0

            _assert_eval_execution_active(
                run_id=run_id,
                lease_token=lease_token,
                deadline_at=deadline_at,
                case_deadline_at=case_deadline_at,
                assert_lease_fn=assert_lease_fn,
                now_fn=now_fn,
            )

            results.append({
                "benchmark_type": BENCHMARK_TYPE,
                "case_id": case_id,
                "question": question,
                "status": "success",
                "overall_score": overall_score,
                "retrieval_overall_score": overall_score,
                "retrieval_score": retrieval_score,
                "answer_score": answer_score,
                "source_score": source_score,
                "source_recall_score": source_recall_score,
                "source_precision_score": source_precision_score,
                "citation_accuracy_score": citation_accuracy_score,
                "keyword_score": keyword_score,
                "answer_keyword_score": answer_keyword_score,
                "grounding_score": grounding_score,
                "judge_score": judge_score,
                "actual_answer": actual_answer,
                "correctness_score": correctness_score,
                "completeness_score": completeness_score,
                "faithfulness_score": faithfulness_score,
                "citation_precision": citation_precision,
                "citation_coverage": citation_coverage,
                "citation_f1": citation_f1,
                "hallucination_rate": hallucination_rate,
                "prompt_version": str(generation_metadata.get("prompt_version") or ""),
                "model_version": str(generation_metadata.get("model_version") or ""),
                "judge_version": str(judge.get("judge_version") or ""),
                "verifier_version": str(generation_metadata.get("verifier_version") or answer_evaluation.get("verifier_version") or ""),
                "claim_evaluation": answer_evaluation,
                "expected_answer_support_score": expected_answer_support_score,
                "expected_answer_support_label": expected_answer_support_label,
                "evidence_label": quality.get("evidence_label") or "weak",
                "support_label": quality.get("support_label") or "unsupported",
                "verification_score": verification_score,
                "risk_level": quality.get("risk_level") or "low",
                "retrieval_recall_at_k": gold_retrieval["recall_at_k"],
                "retrieval_mrr_at_k": gold_retrieval["mrr_at_k"],
                "retrieval_k": gold_retrieval["k"],
                "metric_applicability": metric_applicability,
                "advanced_metrics": advanced_metrics,
                "matched_sources": _matched_sources(documents),
                "latency_ms": int((now_fn() - case_started_at) * 1000),
                "trace_summary": {
                    "benchmark_type": BENCHMARK_TYPE,
                    "run_id": retrieval.get("run_id"),
                    "mode": retrieval.get("mode"),
                    "planned_queries": retrieval.get("planned_queries") or [],
                    "trace_steps": retrieval.get("trace_steps") or [],
                    "quality": quality,
                    "gold_retrieval": gold_retrieval,
                    "metric_applicability": metric_applicability,
                    "expected_answer_verification": expected_answer_verification,
                    "judge": judge,
                    "generation": generation_metadata,
                    "claim_evaluation": answer_evaluation,
                    "advanced_metrics": advanced_metrics,
                },
                "error_message": "",
            })
        except (EvalExecutionStopped, EvalRunDeadlineExceeded):
            raise
        except EvalCaseDeadlineExceeded:
            results.append(_failed_case_result(
                case_id,
                question,
                case_started_at,
                now_fn,
                "Evaluation case deadline exceeded",
                expected_source_files,
                expected_answer,
                expected_keywords,
                evaluation_spec,
            ))
        except Exception:
            results.append(_failed_case_result(
                case_id,
                question,
                case_started_at,
                now_fn,
                "Evaluation case failed",
                expected_source_files,
                expected_answer,
                expected_keywords,
                evaluation_spec,
            ))

    _assert_eval_execution_active(
        run_id=run_id,
        lease_token=lease_token,
        deadline_at=deadline_at,
        case_deadline_at=None,
        assert_lease_fn=assert_lease_fn,
        now_fn=now_fn,
    )
    successful_results = [result for result in results if result["status"] == "success"]
    applicable = lambda result, metric: bool((result.get("metric_applicability") or {}).get(metric))
    retrieval_results = [result for result in results if applicable(result, "retrieval")]
    answer_results = [result for result in results if applicable(result, "answer")]
    faithfulness_results = [result for result in results if applicable(result, "faithfulness")]
    overall_results = [result for result in results if applicable(result, "overall")]
    expected_support_results = [result for result in results if applicable(result, "expected_answer_support")]
    keyword_results = [result for result in results if applicable(result, "keyword_retrieval")]
    return {
        "benchmark_type": BENCHMARK_TYPE,
        "case_count": len(cases),
        "failed_count": len(results) - len(successful_results),
        "successful_case_rate": round(len(successful_results) / len(cases), 4) if cases else 0.0,
        "duration_ms": int((now_fn() - started_at) * 1000),
        "average_overall_score": _average([result["overall_score"] for result in overall_results]),
        "average_retrieval_overall_score": _average([
            result["overall_score"] for result in overall_results
        ]),
        "average_retrieval_score": _average([result["retrieval_score"] for result in retrieval_results]),
        "average_answer_score": _average([result["answer_score"] for result in answer_results]),
        "average_source_score": _average([result["source_score"] for result in retrieval_results]),
        "average_source_recall_score": _average([result["source_recall_score"] for result in retrieval_results]),
        "average_source_precision_score": _average([result["source_precision_score"] for result in retrieval_results]),
        "average_citation_accuracy_score": _average([result["citation_accuracy_score"] for result in faithfulness_results]),
        "average_keyword_score": _average([result["keyword_score"] for result in keyword_results]),
        "average_answer_keyword_score": None,
        "average_grounding_score": _average([result["grounding_score"] for result in faithfulness_results]),
        "average_judge_score": _average([result["judge_score"] for result in answer_results]),
        "average_expected_answer_support_score": _average([result["expected_answer_support_score"] for result in expected_support_results]),
        "average_verification_score": _average([result["verification_score"] for result in successful_results]),
        "average_correctness_score": _average([result["correctness_score"] for result in answer_results]),
        "average_completeness_score": _average([result["completeness_score"] for result in answer_results]),
        "average_faithfulness_score": _average([result["faithfulness_score"] for result in answer_results]),
        "average_citation_precision": _average([
            result["citation_precision"] for result in results
            if applicable(result, "citation_precision")
        ]),
        "average_citation_coverage": _average([
            result["citation_coverage"] for result in results
            if applicable(result, "citation_coverage")
        ]),
        "average_citation_f1": _average([
            result["citation_f1"] for result in results
            if applicable(result, "citation_f1")
        ]),
        "average_hallucination_rate": _average([
            result["hallucination_rate"] for result in results
            if applicable(result, "hallucination_rate")
        ]),
        "metric_applicability": {
            "retrieval_case_count": len(retrieval_results),
            "answer_case_count": len(answer_results),
            "faithfulness_case_count": len(faithfulness_results),
            "overall_case_count": len(overall_results),
        },
        "advanced_metrics": _aggregate_advanced_metrics(results),
        "results": results,
    }

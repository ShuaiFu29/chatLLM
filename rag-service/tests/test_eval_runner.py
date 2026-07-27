import unittest
from pathlib import Path

from eval_runner import _score_expected_keywords, run_eval_cases
from evaluation import evaluate_gold_retrieval_quality, evaluate_retrieval_quality

ROOT = Path(__file__).resolve().parents[1]


class EvalRunnerTests(unittest.TestCase):
    def test_run_eval_cases_calls_agentic_retrieve_with_current_keyword_signature(self):
        calls = []

        def fake_agentic_retrieve(
            query,
            user_id,
            project_space_id=None,
            conversation_id=None,
            limit=5,
            threshold=0.1,
        ):
            calls.append({
                "query": query,
                "user_id": user_id,
                "project_space_id": project_space_id,
                "conversation_id": conversation_id,
                "limit": limit,
                "threshold": threshold,
            })
            return {
                "run_id": "run-signature",
                "mode": "agentic",
                "planned_queries": [query],
                "trace_steps": [],
                "quality": {
                    "retrieval_score": 0.8,
                    "citation_score": 1,
                    "evidence_score": 0.8,
                    "overall_score": 0.8,
                    "evidence_label": "strong",
                },
                "results": [{
                    "id": "chunk-1",
                    "content": "OAuth refresh token rotation evidence.",
                    "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 0},
                    "similarity": 0.8,
                }],
            }

        output = run_eval_cases(
            cases=[{"id": "case-signature", "question": "How does OAuth refresh work?"}],
            user_id="user-1",
            project_space_id="space-1",
            limit=8,
            threshold=0.25,
            agentic_retrieve_fn=fake_agentic_retrieve,
            judge_fn=None,
        )

        self.assertEqual(output["failed_count"], 0)
        self.assertEqual(output["results"][0]["metric_applicability"]["retrieval"], False)
        self.assertEqual(output["results"][0]["metric_applicability"]["answer"], False)
        self.assertEqual(output["results"][0]["overall_score"], 0)
        self.assertEqual(calls, [{
            "query": "How does OAuth refresh work?",
            "user_id": "user-1",
            "project_space_id": "space-1",
            "conversation_id": None,
            "limit": 8,
            "threshold": 0.25,
        }])

    def test_run_eval_cases_scores_keywords_sources_and_trace(self):
        def fake_agentic_retrieve(query, user_id, project_space_id, limit, threshold):
            return {
                "run_id": f"run-{query[:4]}",
                "mode": "agentic",
                "planned_queries": [query, "oauth refresh tokens"],
                "trace_steps": [{"step_type": "retrieve", "status": "success", "duration_ms": 3}],
                "quality": {
                    "retrieval_score": 0.8,
                    "citation_score": 1,
                    "evidence_score": 0.75,
                    "overall_score": 0.82,
                    "evidence_label": "strong",
                    "support_label": "supported",
                    "verification_score": 0.91,
                    "risk_level": "low",
                },
                "results": [
                    {
                        "id": "chunk-1",
                        "content": "OAuth uses GitHub code exchange and refresh token rotation. It stores a short lived access token and rotates refresh tokens for safety.",
                        "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 0},
                        "similarity": 0.91,
                    }
                ],
            }

        output = run_eval_cases(
            cases=[
                {
                    "id": "case-1",
                    "question": "How does OAuth refresh work?",
                    "expected_answer": "OAuth exchanges a GitHub code, uses access tokens, and rotates refresh tokens.",
                    "expected_keywords": ["oauth", "refresh token"],
                    "expected_source_files": ["auth.md"],
                }
            ],
            user_id="user-1",
            project_space_id="space-1",
            agentic_retrieve_fn=fake_agentic_retrieve,
        )

        self.assertEqual(output["case_count"], 1)
        self.assertEqual(output["benchmark_type"], "retrieval_evidence")
        self.assertEqual(output["failed_count"], 0)
        self.assertEqual(output["average_overall_score"], 1)
        self.assertEqual(output["average_answer_score"], 0)
        self.assertEqual(output["results"][0]["case_id"], "case-1")
        self.assertEqual(output["results"][0]["answer_score"], 0)
        self.assertFalse(output["results"][0]["metric_applicability"]["answer"])
        self.assertTrue(output["results"][0]["metric_applicability"]["retrieval"])
        self.assertEqual(output["results"][0]["source_score"], 1)
        self.assertEqual(output["results"][0]["source_recall_score"], 1)
        self.assertEqual(output["results"][0]["source_precision_score"], 1)
        self.assertEqual(output["results"][0]["citation_accuracy_score"], 0)
        self.assertIsNone(output["results"][0]["answer_keyword_score"])
        self.assertEqual(output["results"][0]["grounding_score"], 0)
        self.assertEqual(output["results"][0]["retrieval_recall_at_k"], 1)
        self.assertEqual(output["results"][0]["retrieval_mrr_at_k"], 1)
        self.assertGreaterEqual(output["results"][0]["expected_answer_support_score"], 0.85)
        self.assertEqual(output["results"][0]["expected_answer_support_label"], "supported")
        self.assertEqual(output["results"][0]["keyword_score"], 1)
        self.assertEqual(output["results"][0]["evidence_label"], "strong")
        self.assertEqual(output["results"][0]["support_label"], "supported")
        self.assertEqual(output["results"][0]["verification_score"], 0.91)
        self.assertEqual(output["results"][0]["risk_level"], "low")
        self.assertEqual(output["results"][0]["matched_sources"][0]["filename"], "auth.md")
        self.assertEqual(output["results"][0]["trace_summary"]["planned_queries"][0], "How does OAuth refresh work?")
        self.assertGreaterEqual(output["results"][0]["latency_ms"], 0)
        self.assertEqual(output["average_source_recall_score"], 1)
        self.assertEqual(output["average_citation_accuracy_score"], 0)
        self.assertIsNone(output["average_answer_keyword_score"])
        self.assertEqual(output["average_grounding_score"], 0)
        self.assertGreaterEqual(output["average_expected_answer_support_score"], 0.85)
        self.assertEqual(output["average_verification_score"], 0.91)

    def test_run_eval_cases_records_case_failures_without_aborting_batch(self):
        def failing_agentic_retrieve(query, user_id, project_space_id, limit, threshold):
            raise RuntimeError("vector store unavailable with injected-secret-value")

        output = run_eval_cases(
            cases=[{"id": "case-1", "question": "What failed?"}],
            user_id="user-1",
            agentic_retrieve_fn=failing_agentic_retrieve,
        )

        self.assertEqual(output["case_count"], 1)
        self.assertEqual(output["failed_count"], 1)
        self.assertEqual(output["average_overall_score"], 0)
        self.assertEqual(output["average_answer_score"], 0)
        self.assertEqual(output["results"][0]["answer_score"], 0)
        self.assertEqual(output["results"][0]["source_recall_score"], 0)
        self.assertEqual(output["results"][0]["citation_accuracy_score"], 0)
        self.assertEqual(output["results"][0]["grounding_score"], 0)
        self.assertGreaterEqual(output["results"][0]["latency_ms"], 0)
        self.assertEqual(output["results"][0]["error_message"], "Evaluation case failed")
        self.assertNotIn("injected-secret-value", str(output))

    def test_run_eval_cases_does_not_judge_retrieved_documents_as_an_answer(self):
        judge_calls = []
        def fake_agentic_retrieve(query, user_id, project_space_id, limit, threshold):
            return {
                "run_id": "run-judge",
                "mode": "agentic",
                "planned_queries": [query],
                "trace_steps": [{"step_type": "retrieve", "status": "success", "duration_ms": 1}],
                "quality": {
                    "retrieval_score": 0.6,
                    "citation_score": 1,
                    "evidence_score": 0.6,
                    "overall_score": 0.65,
                    "evidence_label": "partial",
                },
                "results": [
                    {
                        "id": "chunk-1",
                        "content": "The current rule is T+5. T+7 is deprecated.",
                        "metadata": {"filename": "rule.md", "file_id": "file-rule", "chunk_index": 0},
                        "agentic_score": 0.8,
                    }
                ],
            }

        def fake_judge(case, retrieval, documents):
            judge_calls.append(case["id"])
            return {
                "enabled": True,
                "score": 0.92,
                "label": "grounded",
                "reasoning": "The retrieved evidence supports the expected answer.",
            }

        output = run_eval_cases(
            cases=[{
                "id": "case-judge",
                "question": "What is the current response window?",
                "expected_answer": "The current response window is T+5, not deprecated T+7.",
                "expected_keywords": ["T+5", "T+7"],
                "expected_source_files": ["rule.md"],
            }],
            user_id="user-1",
            project_space_id="space-1",
            agentic_retrieve_fn=fake_agentic_retrieve,
            judge_fn=fake_judge,
        )

        result = output["results"][0]
        self.assertEqual(judge_calls, [])
        self.assertEqual(output["average_judge_score"], 0)
        self.assertEqual(result["judge_score"], 0)
        self.assertEqual(result["trace_summary"]["judge"]["label"], "disabled")
        self.assertFalse(result["metric_applicability"]["answer"])

    def test_run_eval_cases_uses_generated_answer_snapshot_and_preserves_raw_dimensions(self):
        retrieval_calls = []
        judge_calls = []
        source = {
            "id": "chunk-policy",
            "content": "Policy FW-4.8.2 requires a 30 day review.",
            "metadata": {"filename": "policy.md", "file_id": "file-policy", "chunk_index": 0},
            "similarity": 0.9,
        }

        def judge(case, retrieval, documents):
            judge_calls.append((case["actual_answer"], documents[0]["id"]))
            return {
                "enabled": True,
                "correctness": 0.9,
                "completeness": 0.8,
                "faithfulness": 0.95,
                "label": "grounded",
                "reasoning": "Supported",
                "model": "judge-model",
                "judge_version": "rag-judge-v2",
            }

        output = run_eval_cases(
            cases=[{
                "id": "case-generated",
                "question": "What is the review period?",
                "expected_source_files": ["policy.md"],
                "actual_answer": "The review period is 30 days. [Source 1]",
                "retrieval_snapshot": {
                    "run_id": "run-generated",
                    "mode": "agentic",
                    "results": [source],
                    "answer_sources": [source],
                    "quality": {"evidence_label": "strong", "support_label": "supported"},
                },
                "answer_evaluation": {
                    "verifier_version": "deterministic-claims-v1",
                    "citation_precision": 1,
                    "citation_coverage": 1,
                    "citation_f1": 1,
                    "hallucination_rate": 0,
                    "claims": [{"text": "The review period is 30 days", "supported": True}],
                    "metric_applicability": {
                        "claim_verification": True,
                        "citation_precision": True,
                        "citation_coverage": True,
                        "citation_f1": True,
                        "hallucination_rate": True,
                    },
                },
                "generation_metadata": {
                    "prompt_version": "grounded-answer-v1",
                    "model_version": "answer-model",
                    "verifier_version": "deterministic-claims-v1",
                },
            }],
            user_id="user-1",
            agentic_retrieve_fn=lambda *args, **kwargs: retrieval_calls.append(args),
            judge_fn=judge,
        )

        self.assertEqual(retrieval_calls, [])
        self.assertEqual(judge_calls, [("The review period is 30 days. [Source 1]", "chunk-policy")])
        result = output["results"][0]
        self.assertEqual(result["actual_answer"], "The review period is 30 days. [Source 1]")
        self.assertEqual(result["correctness_score"], 0.9)
        self.assertEqual(result["completeness_score"], 0.8)
        self.assertEqual(result["faithfulness_score"], 0.95)
        self.assertEqual(result["citation_precision"], 1)
        self.assertEqual(result["citation_coverage"], 1)
        self.assertEqual(result["citation_f1"], 1)
        self.assertEqual(result["hallucination_rate"], 0)
        self.assertEqual(result["prompt_version"], "grounded-answer-v1")
        self.assertEqual(result["judge_version"], "rag-judge-v2")
        self.assertTrue(result["metric_applicability"]["answer"])
        self.assertTrue(result["metric_applicability"]["faithfulness"])
        self.assertEqual(result["overall_score"], 1)

    def test_run_eval_cases_penalizes_expected_answer_that_uses_deprecated_evidence(self):
        def fake_agentic_retrieve(query, user_id, project_space_id, limit, threshold):
            return {
                "run_id": "run-deprecated-answer",
                "mode": "agentic",
                "planned_queries": [query],
                "trace_steps": [{"step_type": "retrieve", "status": "success", "duration_ms": 1}],
                "quality": {
                    "retrieval_score": 0.9,
                    "citation_score": 1,
                    "evidence_score": 0.8,
                    "overall_score": 0.85,
                    "evidence_label": "strong",
                    "support_label": "supported",
                    "verification_score": 0.9,
                    "risk_level": "high",
                },
                "results": [
                    {
                        "id": "chunk-current",
                        "content": "2026 修订版当前总规则规定默认响应确认窗口是 T+5 分钟。",
                        "metadata": {"filename": "01-current.md", "file_id": "current", "chunk_index": 0},
                        "agentic_score": 0.9,
                    },
                    {
                        "id": "chunk-deprecated",
                        "content": "T+7 是 2025 试行版历史口径，已废止，不能替代 2026 当前规则。",
                        "metadata": {"filename": "02-deprecated.md", "file_id": "deprecated", "chunk_index": 0},
                        "agentic_score": 0.88,
                        "source_role": "deprecated",
                    },
                ],
            }

        output = run_eval_cases(
            cases=[{
                "id": "case-deprecated",
                "question": "2026 年默认响应确认窗口是多少？",
                "expected_answer": "2026 年默认响应确认窗口是 T+7。",
                "expected_keywords": ["T+7"],
                "expected_source_files": ["01-current.md", "02-deprecated.md"],
            }],
            user_id="user-1",
            project_space_id="space-1",
            agentic_retrieve_fn=fake_agentic_retrieve,
            judge_fn=None,
        )

        result = output["results"][0]
        self.assertLess(result["grounding_score"], 0.7)
        self.assertLess(result["expected_answer_support_score"], 0.5)
        self.assertEqual(result["expected_answer_support_label"], "unsupported")
        self.assertIn("expected_answer_verification", result["trace_summary"])

    def test_gold_retrieval_uses_source_recall_and_reciprocal_rank(self):
        quality = evaluate_gold_retrieval_quality(
            ["policy.md", "risk.md"],
            [
                {"metadata": {"filename": "noise.md"}},
                {"metadata": {"filename": "RISK.MD"}},
                {"metadata": {"filename": "other.md"}},
            ],
            k=5,
        )

        self.assertTrue(quality["applicable"])
        self.assertEqual(quality["recall_at_k"], 0.5)
        self.assertEqual(quality["mrr_at_k"], 0.5)
        self.assertEqual(quality["retrieval_score"], 0.5)
        self.assertEqual(quality["matched_sources"], ["risk"])
        self.assertEqual(quality["missing_sources"], ["policy"])

    def test_gold_retrieval_without_gold_sources_is_not_applicable(self):
        quality = evaluate_gold_retrieval_quality(
            [],
            [{"metadata": {"filename": "anything.md"}}],
        )

        self.assertFalse(quality["applicable"])
        self.assertEqual(quality["reason"], "no_gold_sources")
        self.assertEqual(quality["retrieval_score"], 0)

    def test_gold_retrieval_accepts_file_id_and_legacy_filename_labels(self):
        quality = evaluate_gold_retrieval_quality(
            ["file-auth", "policy.md"],
            [
                {"metadata": {"file_id": "file-auth", "filename": "auth.md"}},
                {"metadata": {"file_id": "file-policy", "filename": "POLICY.markdown"}},
            ],
        )

        self.assertEqual(quality["recall_at_k"], 1)
        self.assertEqual(quality["source_precision_at_k"], 1)
        self.assertEqual(quality["matched_sources"], ["file-auth", "policy"])

    def test_expected_keywords_use_latin_boundaries_and_chinese_substrings(self):
        score = _score_expected_keywords(
            ["api", "接口"],
            [{"content": "Capitalization rules cover this 接口。"}],
        )

        self.assertEqual(score, 0.5)

    def test_online_evidence_quality_marks_heuristics_and_non_applicable_citations(self):
        quality = evaluate_retrieval_quality(
            "OAuth refresh flow",
            [{
                "content": "OAuth refresh flow rotates tokens.",
                "metadata": {"filename": "auth.md", "file_id": "file-auth", "chunk_index": 0},
                "agentic_score": 1.0,
            }],
        )

        self.assertEqual(quality["score_type"], "heuristic_evidence_quality")
        self.assertFalse(quality["calibrated"])
        self.assertFalse(quality["metric_applicability"]["citation_score"])
        self.assertFalse(quality["metric_applicability"]["exact_marker_coverage"])
        self.assertEqual(quality["exact_marker_coverage"], 0)
        self.assertEqual(quality["provenance_score"], 1)
        self.assertEqual(quality["citation_score_type"], "legacy_provenance_alias")
        self.assertEqual(quality["rank_signal_score"], 1)

    def test_failed_gold_case_remains_in_retrieval_and_overall_average(self):
        def retrieve(query, user_id, project_space_id, limit, threshold):
            if query == "fails":
                raise RuntimeError("retrieval failed")
            return {
                "results": [{
                    "id": "chunk-1",
                    "content": "evidence",
                    "metadata": {"filename": "gold.md", "file_id": "file-1", "chunk_index": 0},
                }],
                "quality": {},
            }

        output = run_eval_cases(
            cases=[
                {"id": "success", "question": "works", "expected_source_files": ["gold"]},
                {"id": "failed", "question": "fails", "expected_source_files": ["gold.md"]},
            ],
            user_id="user-1",
            agentic_retrieve_fn=retrieve,
            judge_fn=None,
        )

        self.assertEqual(output["failed_count"], 1)
        self.assertEqual(output["successful_case_rate"], 0.5)
        self.assertEqual(output["metric_applicability"]["retrieval_case_count"], 2)
        self.assertEqual(output["average_retrieval_score"], 0.5)
        self.assertEqual(output["average_overall_score"], 0.5)
        self.assertTrue(output["results"][1]["metric_applicability"]["retrieval"])

    def test_advanced_aggregates_without_gold_are_not_applicable_or_zero_scored(self):
        document = {
            "id": "chunk-1",
            "content": "Worker uses Queue.",
            "metadata": {"filename": "architecture.md", "chunk_index": 0},
        }

        output = run_eval_cases(
            cases=[{
                "id": "case-without-advanced-gold",
                "question": "What uses the queue?",
                "actual_answer": "Worker uses Queue. [Source 1]",
                "retrieval_snapshot": {"results": [document], "answer_sources": [document]},
            }],
            user_id="user-1",
            judge_fn=lambda _case, _retrieval, _documents: {
                "enabled": True,
                "correctness": 1.0,
                "completeness": 1.0,
                "faithfulness": 1.0,
            },
        )

        advanced = output["advanced_metrics"]
        for name, fields in {
            "chunk_retrieval": ("average_recall_at_k", "average_mrr_at_k"),
            "evidence_retrieval": ("average_recall_at_k", "average_mrr_at_k"),
            "graph_retrieval": ("average_recall_at_k", "average_precision_at_k"),
            "judge_human_calibration": ("mae", "agreement_rate"),
        }.items():
            with self.subTest(metric=name):
                self.assertFalse(advanced[name]["applicable"])
                self.assertEqual(advanced[name]["case_count"], 0)
                for field in fields:
                    self.assertIsNone(advanced[name][field])

    def test_unanswerable_case_with_verified_abstention_is_correct(self):
        output = run_eval_cases(
            cases=[{
                "id": "case-unanswerable",
                "question": "What is the undocumented secret?",
                "actual_answer": "The supplied sources do not contain enough evidence to answer.",
                "retrieval_snapshot": {"results": []},
                "answer_evaluation": {"abstained": True},
                "evaluation_spec": {"expected_answerable": False},
            }],
            user_id="user-1",
            judge_fn=None,
        )

        answerability = output["results"][0]["advanced_metrics"]["answerability"]
        self.assertTrue(answerability["applicable"])
        self.assertEqual(answerability["accuracy"], 1.0)
        self.assertEqual(answerability["false_answer"], 0.0)
        self.assertEqual(output["advanced_metrics"]["answerability"]["accuracy"], 1.0)
        self.assertEqual(output["advanced_metrics"]["answerability"]["false_answer_rate"], 0.0)

    def test_token_usage_derives_total_when_provider_only_returns_prompt_and_completion(self):
        document = {
            "id": "chunk-1",
            "content": "Worker uses Queue.",
            "metadata": {"filename": "architecture.md", "chunk_index": 0},
        }
        output = run_eval_cases(
            cases=[{
                "id": "case-token-usage",
                "question": "What uses the queue?",
                "actual_answer": "Worker uses Queue. [Source 1]",
                "retrieval_snapshot": {"results": [document], "answer_sources": [document]},
                "generation_metadata": {"token_usage": {"prompt_tokens": 10, "completion_tokens": 5}},
            }],
            user_id="user-1",
            judge_fn=lambda _case, _retrieval, _documents: {
                "enabled": True,
                "correctness": 1.0,
                "completeness": 1.0,
                "faithfulness": 1.0,
                "token_usage": {"prompt_tokens": 7, "completion_tokens": 3},
            },
        )

        usage = output["advanced_metrics"]["token_usage"]
        self.assertTrue(usage["applicable"])
        self.assertEqual(usage["answer"]["total_tokens"], 15)
        self.assertEqual(usage["judge"]["total_tokens"], 10)

    def test_main_exposes_eval_run_endpoint(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("EvalRunRequest", source)
        self.assertIn("expected_answer: str", source)
        self.assertIn('@app.post("/eval/run")', source)
        self.assertIn("run_eval_cases(", source)
        self.assertIn('@app.post("/ingest-sync")', source)

    def test_eval_run_endpoint_bounds_case_count(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("cases: list[EvalCaseRequest] = Field(..., min_length=1, max_length=50)", source)

    def test_eval_lease_loss_after_retrieval_stops_judge_and_later_cases(self):
        active = True
        checks = []
        retrieval_calls = []
        judge_calls = []

        def assert_lease(run_id, lease_token):
            checks.append((run_id, lease_token))
            if not active:
                raise RuntimeError("eval lease lost")

        def retrieve(query, user_id, project_space_id, limit, threshold):
            nonlocal active
            retrieval_calls.append(query)
            active = False
            return {"results": [], "quality": {}}

        def judge(case, retrieval, documents):
            judge_calls.append(case["id"])
            return {"enabled": True, "score": 1.0}

        with self.assertRaisesRegex(RuntimeError, "eval lease lost"):
            run_eval_cases(
                cases=[
                    {"id": "case-1", "question": "first"},
                    {"id": "case-2", "question": "second"},
                ],
                user_id="user-1",
                run_id="11111111-1111-4111-8111-111111111111",
                lease_token="22222222-2222-4222-8222-222222222222",
                deadline_at=100.0,
                case_timeout_ms=10000,
                assert_lease_fn=assert_lease,
                now_fn=lambda: 0.0,
                agentic_retrieve_fn=retrieve,
                judge_fn=judge,
            )

        self.assertGreaterEqual(len(checks), 2)
        self.assertEqual(retrieval_calls, ["first"])
        self.assertEqual(judge_calls, [])

    def test_eval_lease_loss_after_judge_stops_later_cases(self):
        active = True
        retrieval_calls = []
        judge_calls = []

        def assert_lease(_run_id, _lease_token):
            if not active:
                raise RuntimeError("eval cancelled after judge")

        def retrieve(query, user_id, project_space_id, limit, threshold):
            retrieval_calls.append(query)
            return {"results": [], "quality": {}, "actual_answer": "answer under evaluation"}

        def judge(case, retrieval, documents):
            nonlocal active
            judge_calls.append(case["id"])
            active = False
            return {"enabled": True, "score": 1.0}

        with self.assertRaisesRegex(RuntimeError, "eval cancelled after judge"):
            run_eval_cases(
                cases=[
                    {"id": "case-1", "question": "first"},
                    {"id": "case-2", "question": "second"},
                ],
                user_id="user-1",
                run_id="33333333-3333-4333-8333-333333333333",
                lease_token="44444444-4444-4444-8444-444444444444",
                deadline_at=100.0,
                case_timeout_ms=10000,
                assert_lease_fn=assert_lease,
                now_fn=lambda: 0.0,
                agentic_retrieve_fn=retrieve,
                judge_fn=judge,
            )

        self.assertEqual(retrieval_calls, ["first"])
        self.assertEqual(judge_calls, ["case-1"])

    def test_case_deadline_fails_only_the_slow_case(self):
        clock = [0.0]

        def retrieve(query, user_id, project_space_id, limit, threshold):
            if query == "slow":
                clock[0] = 2.0
            return {"results": [], "quality": {}}

        output = run_eval_cases(
            cases=[
                {"id": "case-slow", "question": "slow"},
                {"id": "case-fast", "question": "fast"},
            ],
            user_id="user-1",
            run_id="55555555-5555-4555-8555-555555555555",
            lease_token="66666666-6666-4666-8666-666666666666",
            deadline_at=100.0,
            case_timeout_ms=1000,
            assert_lease_fn=lambda _run_id, _lease_token: None,
            now_fn=lambda: clock[0],
            agentic_retrieve_fn=retrieve,
            judge_fn=None,
        )

        self.assertEqual(output["case_count"], 2)
        self.assertEqual(output["failed_count"], 1)
        self.assertEqual(output["results"][0]["error_message"], "Evaluation case deadline exceeded")
        self.assertEqual(output["results"][1]["status"], "success")

    def test_whole_run_deadline_stops_before_retrieval(self):
        retrieval_calls = []

        with self.assertRaises(TimeoutError):
            run_eval_cases(
                cases=[{"id": "case-1", "question": "too late"}],
                user_id="user-1",
                run_id="77777777-7777-4777-8777-777777777777",
                lease_token="88888888-8888-4888-8888-888888888888",
                deadline_at=1.0,
                case_timeout_ms=1000,
                assert_lease_fn=lambda _run_id, _lease_token: None,
                now_fn=lambda: 2.0,
                agentic_retrieve_fn=lambda *args, **kwargs: retrieval_calls.append(args),
                judge_fn=None,
            )

        self.assertEqual(retrieval_calls, [])

    def test_eval_endpoint_and_database_require_the_current_lease(self):
        main_source = (ROOT / "main.py").read_text(encoding="utf-8")
        db_source = (ROOT / "db.py").read_text(encoding="utf-8")

        self.assertIn("run_id: UUID", main_source)
        self.assertIn("lease_token: UUID", main_source)
        self.assertIn("deadline_at: datetime", main_source)
        self.assertIn(
            "case_timeout_ms: int = Field(..., ge=1, le=2147483647)",
            main_source,
        )
        self.assertIn("assert_eval_lease_active", db_source)
        self.assertRegex(db_source, r"lease_token\s*=\s*%s")
        self.assertRegex(db_source, r"lease_expires_at\s*>\s*now\(\)")
        self.assertRegex(db_source, r"deadline_at\s*>\s*now\(\)")
        self.assertIn("except EvalExecutionStopped", main_source)
        self.assertIn("status_code=409", main_source)
        self.assertIn("except EvalRunDeadlineExceeded", main_source)
        self.assertIn("status_code=408", main_source)


if __name__ == "__main__":
    unittest.main()

# RAG Answer Grounding and Evaluation Calibration Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-14-rag-answer-grounding-eval-calibration-design.md`

**Goal:** Repair final-answer evidence/citation attrition and deliver a deterministic, explainable offline full-answer evaluator without allowing answer-pack data into project storage or answer-generation prompts.

## Phase 1: Reproducible baseline tooling

1. Add script-level tests for answer-table parsing, concept alternatives, numeric/version/polarity conflicts, source recall, citation loss, unscorable cases, grading, and isolation metadata.
2. Implement a reusable offline answer scorer and CLI. Keep actual-run and expectation loading separate; redact expected answers from output and operational logs.
3. Add a reproducible chat-run harness that creates one temperature-zero conversation per case, parses SSE retrieval/final-grounding events, records actual answers and sources, and never reads expectations while generating answers.
4. Run focused script tests and produce the current-code 50-case baseline before any Server behavior change.

## Phase 2: Answer context and grounding repair

5. Add failing Server tests for fair context packing, stable labels, complete verification evidence after display character 500, citation-local multi-source verification, invalid labels, numeric/version/polarity conflicts, and bounded display snippets.
6. Implement fair context packing with traceable allocation metadata while preserving the public chat response shape.
7. Add the answer completeness/citation contract without using expected-answer data.
8. Decouple complete verification evidence from bounded UI/storage snippets and implement claim-local citation verification with hard factual conflict reasons.
9. Run focused Server and script tests, then build Server.

## Phase 3: Issue documentation and complete regression

10. Create detailed local `ISSUE-064-rag-final-answer-citation-attrition.md` and `ISSUE-065-rag-final-answer-evaluation-calibration.md`, following the full 061–063 causal-analysis structure and recording the pre-fix baseline.
    - Implementation clarification: use a frozen JSON sidecar for structured obligations, record retrieval/prompt/model/verifier/final citation stages, and use scoped exact-marker source bundles instead of arbitrary same-file chunk selection.
11. Restart only changed services, then run the same 50-case generation and offline scoring configuration.
12. Diagnose every failed acceptance gate by per-case reason; continue implementation until the fixed gates pass without lowering thresholds.
13. Run full `npm test`, lint, build, static checks, and diff checks.
14. Audit PostgreSQL, MinIO, Milvus, Elasticsearch, Neo4j, RAG eval tables, corpus manifest, and report artifacts for zero answer pollution.
15. Update both local Issues with final metrics, commit all tracked code/tests/docs, restart changed services, verify three health endpoints, and confirm a clean worktree.

## Acceptance Gates

- Retrieved expected-source recall >= 90%.
- Final verified-source recall >= 75%.
- Required-concept coverage >= 75%.
- No numeric, version, time-window, or polarity hard conflict among passing cases.
- Grounding unsupported <= 4/50.
- Fail <= 5/50 and pass >= 30/50.
- Deterministic scorer fixtures distinguish equivalent, partial, contradictory, unsupported, citation-loss, and unscorable cases.
- All project tests/build/lint pass and answer pollution remains zero.

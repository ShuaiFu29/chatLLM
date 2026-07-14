# RAG Reliability and Answer Quality Hardening Design

**Date:** 2026-07-14

**Status:** Approved through the active Goal and the user's standing authorization for autonomous implementation

**Scope:** Permanently repair six defects found by the isolated 50-case intelligent-manufacturing evaluation: retrieval timeout, silent non-RAG fallback, readiness false negatives, cross-language grounding rejection, numeric-score false positives, and missing concepts/citations plus guide-source authority mistakes.

## Evidence and Baseline

Only the 24 files under `rag-demo/智能制造质量追溯与供应链索赔争议/corpus/` were ingested. The answer pack was not uploaded, chunked, indexed, stored in evaluation tables, or sent to the answer model.

The clean cold-cache run with the current default 10-second retrieval timeout produced 22 pass, 17 partial, and 11 fail. All 11 retrieval-free answers corresponded to Server-side Axios `ECONNABORTED` errors followed by the current silent base-model fallback. Raising the process-only retrieval timeout to 60 seconds and clearing retrieval cache produced 27 pass, 20 partial, and 3 fail, with zero retrieval failures and 93.50% retrieved-source recall.

The remaining strict failures exposed two evaluator/verifier false negatives and one genuine answer defect:

- E09 correctly answered a Chinese evidence question in English, but lexical grounding rejected the citation.
- E39 correctly explained the 70% threshold, but `[Chunk 3]` was interpreted as a business number and the omitted optional 90% tier triggered a numeric conflict.
- E47 treated an index guide as sufficient evidence instead of preserving the guide's explicit statement that primary policy, report, ledger, or minutes evidence is required.

## Considered Approaches

### Configuration-only timeout increase

Increase `RAG_RETRIEVE_TIMEOUT_MS` and `RAG_HEALTH_TIMEOUT_MS` only. This removes many timeouts but leaves silent hallucination fallback, no bounded retry semantics, weak observability, verifier false negatives, and citation loss. It is rejected as incomplete.

### Asynchronous retrieval jobs

Move chat retrieval to a durable asynchronous job with polling and cancellation. This offers strong control for minute-scale retrieval but changes the chat protocol, persistence model, UI, and operational architecture. It is deferred because observed retrieval completes within a bounded synchronous window.

### Selected: bounded synchronous reliability and deterministic quality repair

Keep the existing chat and SSE architecture. Add a total retrieval deadline, one transient retry, fail-closed RAG behavior, realistic readiness timeout, deterministic bilingual grounding normalization, structural-number filtering, uncited-claim source attribution, and explicit guide authority handling. This directly repairs the observed failure chain without schema changes or an unrelated platform rewrite.

## 1. Retrieval Timeout and Retry

Add explicit Server configuration:

- `RAG_RETRIEVE_TIMEOUT_MS=30000`: maximum duration of one attempt;
- `RAG_RETRIEVE_MAX_ATTEMPTS=2`: one initial attempt plus at most one retry;
- `RAG_RETRIEVE_TOTAL_TIMEOUT_MS=60000`: hard wall-clock budget including backoff;
- `RAG_RETRIEVE_RETRY_DELAY_MS=250`: bounded retry delay;
- `RAG_HEALTH_TIMEOUT_MS=10000`: readiness budget aligned with the real deep readiness probe.

Retry only failures classified as transient: timeout/no response, HTTP 429, and HTTP 5xx. Never retry authentication, authorization, validation, or other 4xx errors. Respect caller cancellation and the total deadline. A retry must not extend the request beyond the total budget.

The RAG client records attempts, final outcome, and elapsed duration. The circuit breaker observes final operation outcomes rather than turning one user request into multiple independent product-level failures.

## 2. Fail-Closed RAG Chat Behavior

When RAG is enabled and routing selects RAG, retrieval failure must stop answer generation. The Server emits a structured SSE event:

```json
{
  "ragError": {
    "code": "rag_retrieval_unavailable",
    "retryable": true,
    "message": "Workspace document retrieval failed. Retry before relying on an answer."
  }
}
```

The Server then emits `[DONE]` and does not call the base model, persist an assistant answer, create a successful RAG run, or attach empty evidence to generated prose. The already-persisted user message remains so the user can retry. Deliberate routing skips for greetings or non-knowledge messages remain unchanged.

The Client keeps the temporary assistant row as a visible error state, presents localized text saying no answer was generated, and does not claim that a base-model fallback occurred. Existing streams remain compatible with source, trace, content, and completion events.

## 3. Readiness Semantics

The Server continues to call the RAG deep `/health/ready` endpoint so dependency failures are not hidden. Its default timeout becomes 10 seconds, matching the observed local dependency fan-out. A timeout is still `not_ready`; the fix removes false negatives rather than converting dependency readiness into mere liveness.

Tests cover a probe completing after two seconds, a real timeout, and a returned dependency failure. Runtime and example configuration must agree, and the capacity checker must reject a health timeout that is clearly below the supported profile.

## 4. Cross-Language Grounding Verification

Grounding remains deterministic and does not call an LLM judge. Before term comparison, claims and source clauses pass through a bilingual canonicalization layer for common evidence and workflow language: audit, management review, closure, upgrade, compensation, supplier deduction, notification, approval, evidence, policy, report, ledger, and related inflections.

Exact identifiers, versions, dates, percentages, amounts, and negation remain hard constraints. A citation may use the bilingual path only when:

- exact claim markers are all present in the cited source;
- at least one canonical bilingual concept overlaps;
- no numeric, version, or polarity conflict exists.

This prevents an identifier-only citation from passing while allowing faithful English paraphrases of Chinese evidence. Decisions report whether support came from direct lexical overlap or bilingual canonical overlap.

## 5. Numeric Evaluation Safety

Before extracting business numbers, the offline scorer removes structural artifacts:

- `[Source N]`, `[Chunk N]`, `[Inventory N]`, and equivalent localized labels;
- Markdown ordered-list prefixes and heading numbers;
- citation footnote labels;
- version and identifier tokens already handled by their dedicated detectors.

Only numbers declared as required in the scoring contract are critical. Optional concepts cannot become mandatory merely because their human-readable expected answer contains a number. An unexpected number becomes a hard conflict only when it occupies the same declared numeric fact role as a required value, or matches an explicit forbidden value. E39 must not fail for `[Chunk 3]` or for omitting the optional 90% tier.

## 6. Completeness, Citation Recovery, and Source Authority

### Answer contract

Strengthen the existing expectation-free prompt contract:

- answer in the user's language;
- answer every explicit part before adding explanation;
- cite each material document-backed sentence locally;
- preserve limitations such as incomplete, conditional, historical, draft, or index-only;
- never elevate a guide/index into primary business evidence;
- if a guide is the subject of the question, explain its authority boundary and identify the primary-source classes required by the guide.

No answer-pack keyword or expected source enters generation.

### Deterministic uncited-claim attribution

After generation, split substantive uncited sentences and compare them with complete verification evidence. A source may be attached to final source metadata only when marker coverage is complete, semantic/canonical overlap passes a conservative threshold, and no hard conflict exists. Auto-attributed sources are separately reported and never represented as model-written citation labels.

This recovers trustworthy source cards and citation-flow visibility without mutating already-streamed model text or pretending the model supplied citations. Unsupported uncited claims remain unsupported.

### Guide authority

Preserve the existing retrieval rule: guides are down-ranked for ordinary business questions and retained for explicit guide/index questions. Pass source-role metadata into answer context. When a guide is retrieved, its header states that it is navigational unless the question asks about the guide itself. Even for an explicit guide question, the answer must preserve statements that primary documents are required.

## Error Handling and Observability

- Retrieval attempts expose stable reason codes for timeout, circuit open, rate limit, upstream 5xx, invalid request, cancellation, and unknown failure.
- Operational logs contain request IDs and safe error fields, never tokens, prompts, answer-pack content, or full retrieved documents.
- Metrics distinguish first-attempt success, retry success, terminal retrieval failure, and fail-closed chat completion.
- A health timeout does not consume retrieval circuit-breaker state.
- Scoring reports structural numbers ignored during normalization for auditability.

## Test Strategy

### Server and Client

- RAG timeout retries once and succeeds within the total deadline.
- Non-transient 4xx errors do not retry.
- Cancellation stops retry and model generation.
- Terminal RAG failure emits `ragError`, `[DONE]`, and zero model content.
- A RAG-routed failure persists no assistant hallucination and no successful RAG run.
- Non-RAG routed messages still use the model normally.
- The Client renders a localized retryable retrieval error and does not display fallback wording.
- The 10-second readiness budget accepts the observed deep probe while real dependency failure remains `not_ready`.

### Grounding and scorer

- English paraphrases of Chinese evidence pass only with matching markers and bilingual concepts.
- Cross-language claims with wrong numbers, versions, or polarity fail.
- `[Chunk 3]`, `[Source 8]`, list numbering, and footnotes do not become business numbers.
- Optional numeric concepts do not create required numeric conflicts.
- Strong uncited claims can recover explicit auto-attributed source metadata; weak matches cannot.
- An explicit index question must preserve the "index is insufficient" authority boundary.

### Full regression

- Run focused Node and Python suites, complete Server and Client suites, and environment/capacity checks.
- Stop services, clear all project data, upload only the 24 corpus files, and verify 153 chunks across PostgreSQL, Milvus, Elasticsearch, and Neo4j plus 24 MinIO objects.
- Prove zero answer-like stored artifacts and zero evaluation dataset/case rows.
- Generate 50 answers from the questions-only manifest at temperature 0 before reading the answer pack.
- Score offline only after the actual artifact is closed.

## Fixed Acceptance Gates

The Goal is complete only when all of these are true:

- zero silent base-model fallbacks for RAG-routed retrieval failures;
- zero retrieval timeouts in the isolated 50-case supported profile;
- retrieved expected-source recall at least 90%;
- final verified-source recall at least 75%;
- required-concept coverage at least 75%;
- zero numeric, version, and polarity conflicts caused by structural parsing;
- at most 4 unsupported grounding results;
- at most 5 failed cases and at least 30 passed cases;
- all answer-isolation checks remain zero;
- all changed behavior is covered by automated regression tests;
- tracked implementation is committed and the working tree has no unintended changes.

Thresholds must not be relaxed after observing the result.

## Issue Documentation

Create six detailed local issue documents and add them to `issue/README.md`:

- ISSUE-066: Agentic RAG retrieval timeout budget is below real cold-cache latency;
- ISSUE-067: RAG retrieval failure silently falls back to an ungrounded model answer;
- ISSUE-068: deep RAG readiness is misclassified by an unrealistically short timeout;
- ISSUE-069: cross-language evidence paraphrases are rejected by lexical grounding;
- ISSUE-070: structural citation labels trigger numeric-conflict scoring;
- ISSUE-071: answer completeness, citation recovery, and guide authority are not enforced end to end.

Each issue explains the normal path, trigger, direct cause, full failure chain, deeper design cause, amplifiers, test escape, user/business impact, repair, and verification evidence in language understandable without reading code.

## Rollout and Recovery

No schema migration is required. Deploy Server, Client, RAG metadata, scorer, and configuration changes together. Existing messages remain readable. Rollback is code-only; stored corpus data and indexes do not require transformation.


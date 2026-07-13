# RAG Answer Grounding and Evaluation Calibration Design

**Date:** 2026-07-14

**Status:** Approved through the active Goal and standing user authorization for autonomous implementation

**Scope:** Repair final-answer evidence use and citation attrition after retrieval, and add an auditable offline answer-quality scorer that separates genuine answer defects from evaluation false negatives. The design preserves the existing chat, retrieval, storage, and public API architecture.

## Implementation Clarification After Empirical Review

The flat Markdown answer table remains the human-readable source, while a frozen JSON sidecar records only structure the table cannot safely express: required versus optional concepts, declared equivalents, numeric/version/polarity roles, and `requiredAll`/`requiredAny` source obligations. The sidecar is read only after generation and its hash is recorded in the score report.

Citation attrition is reported as first-failure stages: retrieval miss, context omission, model citation omission, verifier rejection, and artifact loss. A source obligation is counted once at its earliest failed stage.

When a question explicitly names an exact document, version, or case marker, retrieval may load bounded chunks only for an already retrieved file in the same user and project-space scope. Those chunks are relevance-ordered into one source-depth bundle that replaces partial chunks from the same file. This prevents later sections from disappearing while preserving source identity and authorization boundaries.

## Problem Statement

The isolated intelligent-manufacturing evaluation ingested only the 24 Markdown files under `rag-demo/智能制造质量追溯与供应链索赔争议/corpus/`. The answer pack remained outside PostgreSQL, MinIO, Milvus, Elasticsearch, Neo4j, and all answer-generation prompts.

Before the routing and guide-ranking fixes, a forced-retrieval 50-case run showed:

- retrieved expected-source recall: 93.83%;
- final cited-source recall: 58.83%;
- answer keyword recall: 61.12%;
- 18 pass, 19 partial, and 13 fail;
- 10 supported, 28 partial, and 12 unsupported grounding results;
- two polarity mismatches.

The historical run is diagnostic evidence, not the final pre-change baseline, because it predates the first three RAG fixes. A new complete 50-case baseline must run against the current code before implementation changes are enabled.

Two independent defects are in scope:

1. Correct evidence can be retrieved but omitted from the model context, incompletely used in the answer, or removed from final citations by a verifier that sees less evidence than the model saw.
2. The existing complete-answer scoring used for the isolated experiment is not a committed, reusable, explainable project component. Exact keyword and hard aggregate grading can conflate equivalent wording, partial coverage, real contradictions, citation loss, and benchmark defects.

## Root-Cause Evidence

### Evidence and citation asymmetry

`buildRagContextText` can provide up to 12,000 characters of retrieved content to the answer model, while `buildChatSources` truncates each source to 500 characters. `verifyAnswerGrounding` currently receives those 500-character display snippets rather than the complete retrieved chunks. A claim supported after character 500 can therefore be visible to the model but invisible to the verifier.

The verifier also compares the terms from the entire multi-source answer with each individual source. A source that correctly supports one cited claim can receive a low score because it does not overlap unrelated claims supported by other sources. When the aggregate status becomes `unsupported`, all final sources are removed.

### Evaluation responsibility gap

The built-in Python `eval_runner.py` evaluates whether retrieved documents can support an expected answer. It does not generate or grade the actual final chat answer. The prior full-answer report was produced outside the committed reusable evaluation path. Consequently, retrieval support and final answer quality can be confused, and failures do not have stable reason codes that identify the responsible stage.

## Selected Approach

Use a deterministic, claim-aware evidence path and deterministic offline scoring as the acceptance authority. An LLM judge may run as optional shadow diagnostics but cannot override hard facts or decide release gates.

Rejected alternatives:

- Prompt-only tuning cannot repair evidence asymmetry in the post-generation verifier and can inflate prose without improving attribution.
- Threshold-only tuning can make metrics green while preserving incorrect numbers, polarity, or citations.
- A judge-only scorer recognizes paraphrases but is nondeterministic, costly, and requires sending the answer pack to another model.

## Answer Context Architecture

### Fair context packing

Replace sequential first-source consumption with deterministic fair packing:

1. Remove empty documents and preserve rerank order.
2. Reserve header and separator space.
3. Allocate an initial per-source share so every selected source contributes evidence when the total budget permits.
4. Redistribute remaining characters by rank to sources with unused content.
5. Record included and omitted character counts per source for traceability.

The packer must never claim that a source entered the prompt when its body received zero characters. Source labels remain stable across prompt context, model citations, UI sources, and verification.

### Answer contract

The answer prompt must require the model to:

- answer every explicit subquestion;
- preserve material numbers, units, versions, dates, conditions, exceptions, and negation;
- place `[Source N]` immediately after each substantive document-backed claim;
- distinguish current rules from deprecated or historical material;
- state that evidence is insufficient rather than fill gaps with general knowledge;
- avoid citing an index or evaluation guide as the primary basis for an ordinary business conclusion.

No expected answer, expected keyword, or expected source is used to build this contract.

## Grounding Verification Architecture

Separate three representations that are currently conflated:

1. **Prompt evidence:** packed content shown to the model.
2. **Verification evidence:** complete retrieved chunk content used only by the server verifier.
3. **Display sources:** bounded snippets stored and returned to the client.

The verifier will parse valid `[Source N]` labels and split the answer into nearby claims. Each cited claim is checked against its referenced complete evidence, not against an unrelated source and not against only the first 500 characters.

Verification combines:

- local Chinese/English term and shingle overlap;
- exact marker coverage for model numbers, versions, dates, amounts, percentages, and time windows;
- local polarity consistency around matched markers and predicates;
- retrieval-quality constraints already reported by the RAG service.

Hard conflicts in numbers, versions, or polarity cannot be rescued by generic lexical similarity. Out-of-range labels, citations with no nearby claim, and claims whose cited source lacks support receive explicit reasons.

The final UI/storage source list contains only sources that the model actually cited and whose nearby claims passed verification. If no citation labels are produced, a conservative collective-support fallback may mark the answer partial, but it must not pretend that every retrieved source was cited.

## Offline Full-Answer Evaluation

Add a committed reusable scorer for actual chat-run artifacts. It consumes two inputs only after answer generation finishes:

- actual results: case ID, question, answer, retrieved sources, final verified sources, grounding result, and timing;
- offline expectations: expected answer, required concepts, and expected source files.

The scorer must never call the chat endpoint, retrieval endpoint, ingestion endpoint, or project databases with expectation data. It writes only a local evaluation report.

### Scoring dimensions

Each case reports independently:

- required-concept coverage;
- normalized numeric and unit consistency;
- version and time-window consistency;
- clause-local polarity consistency;
- retrieved expected-source recall;
- final verified-source recall;
- grounding status and score;
- invalid or unsupported citation count.

Required concepts may declare explicit alternatives, such as `T+3|3个工作日`. Existing single-value keywords remain valid. Generic character/token similarity may supplement concept coverage but cannot override hard conflicts.

### Grades and reasons

- `pass`: core facts are covered, no hard conflict exists, and citations are supportable.
- `partial`: the answer direction is correct but omits material concepts or expected sources, or grounding is incomplete without a hard contradiction.
- `fail`: a key number, version, time window, or polarity is wrong; the central answer is missing; or the answer is unsupported.
- `unscorable`: expectation data is absent, malformed, or cannot be linked to an actual case.

Stable reason codes include:

- `missing_required_concept`;
- `numeric_conflict`;
- `version_conflict`;
- `polarity_conflict`;
- `retrieval_miss`;
- `citation_loss`;
- `invalid_citation`;
- `unsupported_claim`;
- `missing_expectation`.

An optional judge result is recorded under a separate shadow field. Judge timeout, invalid JSON, or disagreement cannot change the deterministic grade.

## Isolation and Reproducibility

Every complete 50-case run must:

- use a dedicated conversation per case;
- use temperature 0;
- keep model, project space, retrieval limit, and threshold fixed;
- record corpus filenames and a corpus manifest hash;
- record the answer-pack hash without copying expected answers into the actual-run artifact;
- run an artifact audit proving no answer-like PostgreSQL filename, MinIO key, Milvus row, Elasticsearch document, Neo4j document, or RAG eval dataset/case exists;
- keep actual answers and offline scored results in local report files outside project storage.

The pre-change and post-change reports must retain configuration and per-case reasons so aggregate improvements cannot conceal regressions.

## Error Handling

- Empty or malformed source content is excluded and traced.
- Context packing reports truncation instead of silently dropping evidence.
- Out-of-range and malformed source labels are invalid citations.
- Missing evidence plus a cautious refusal is partial, not hallucination.
- Missing expectation data is unscorable, not a project failure.
- One case timeout or scoring parse failure is recorded per case and does not erase other results.
- Optional judge failure never stops deterministic scoring.
- Reports must not print secrets or full expected answers to operational logs.

## Test Strategy

### Server unit tests

- Fair packing includes all sources within budget and redistributes unused shares.
- Source numbering is stable when content is empty or truncated.
- A claim supported after display character 500 remains grounded through full verification evidence.
- Multi-source claims verify against their local citation rather than the whole answer.
- Wrong numbers, versions, time windows, polarity, out-of-range labels, and unsupported claims fail.
- Display snippets remain bounded and do not leak full source content.

### Scorer unit tests

- Exact and declared-equivalent concepts pass.
- Correct partial answers remain partial.
- Numeric, version, and polarity conflicts fail even under high lexical overlap.
- Retrieval miss and citation loss are distinguished.
- Missing expectations become unscorable.
- Optional judge disagreement cannot override deterministic hard gates.

### Integration and full verification

- Chat SSE preserves stable source labels and returns explainable grounding reasons.
- Existing RAG, chat, trace, UI, and eval behavior remains compatible.
- Full lint, build, Node/script, client, server, and Python suites pass.
- A complete post-fix 50-case run uses the same configuration as the new current-code baseline.

## Acceptance Gates

The post-fix isolated run must satisfy all of the following without lowering gates after seeing results:

- retrieved expected-source recall at least 90%;
- final verified-source recall at least 75%;
- required-concept coverage at least 75%;
- zero numeric, version, time-window, and polarity hard conflicts among passing cases;
- at most 4 of 50 grounding results marked unsupported;
- at most 5 of 50 failed cases;
- at least 30 of 50 fully passing cases;
- all deterministic scorer fixtures correctly distinguish equivalent, partial, contradictory, and unsupported answers;
- zero answer-pack pollution across all project stores and evaluation tables.

If a gate fails, the implementation continues from per-case reasons. Thresholds are not relaxed to manufacture completion.

## Issue Documentation

Create two local Issue documents under the ignored `issue/` directory:

- `ISSUE-064-rag-final-answer-citation-attrition.md`;
- `ISSUE-065-rag-final-answer-evaluation-calibration.md`.

Each document follows the detailed 061–063 structure: normal path, trigger, direct cause, complete failure chain, deeper cause, amplifiers, test escape, business impact, causal summary, and how the fix breaks the chain. Baseline and final metrics are recorded separately.

## Rollout and Recovery

The implementation is code-only and introduces no schema migration. Deploy the Server changes and evaluation script together. Existing chat history remains readable. If grounding behavior regresses, the Server commit can be rolled back without modifying stored documents or vector indexes.

## Completion Criteria

Completion requires the current-code baseline, implemented code, focused and full tests, post-fix 50-case run, all acceptance gates, two detailed local Issues, clean isolation audit, committed tracked files, clean working tree, and healthy Client, Server, and RAG services.

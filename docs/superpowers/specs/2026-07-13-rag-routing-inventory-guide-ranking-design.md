# RAG Routing, Inventory Intent, and Guide Ranking Remediation Design

**Date:** 2026-07-13

**Status:** User-approved; implementation authorized

**Scope:** Fix the three highest-impact defects found by the isolated intelligent-manufacturing RAG evaluation without changing the storage architecture, public API shape, or answer-grounding system.

## Problem Statement

The isolated evaluation loaded only the 24 Markdown files under `rag-demo/智能制造质量追溯与供应链索赔争议/corpus/`. The answer pack remained outside project storage and model prompts. The current production path showed three major defects:

1. Only 4 of 50 domain questions triggered RAG. The other 46 were sent to the chat model without corpus context or citations even though RAG was enabled.
2. Content questions containing broad phrases such as “有什么” or “有哪些” can be misrouted to `metadata_inventory` when a document-scope word is also present.
3. `00-语料索引与测试指南.md` appeared in the Retrieval Lab Top 3 for 16 of 36 questions. Existing guide demotion does not recognize this Chinese filename, so the guide is treated as primary evidence.

The defects are severe because they can produce fluent but unverifiable answers while the interface reports no retrieval failure.

## Selected Approach

Use deterministic, query-aware rules. Do not add an LLM classifier or another remote dependency.

### RAG trigger

When a conversation has RAG enabled, every non-empty message retrieves by default. Retrieval is skipped only for narrow, explicit categories whose answer does not depend on workspace knowledge:

- greetings and social acknowledgements;
- explicit translation requests;
- explicit writing or rewriting requests that contain the text to transform;
- simple arithmetic expressions.

Ambiguous or domain-specific questions retrieve. The trigger returns an observable reason such as `default_rag` or `explicit_skip`, while preserving the existing inventory and explicit-knowledge reasons where they are useful for diagnostics.

This intentionally prefers a small increase in embedding and retrieval work over silently answering enterprise questions without evidence.

### Inventory intent

`metadata_inventory` is reserved for requests about the collection of uploaded files, not the contents of a file.

An inventory request must contain both:

1. an explicit collection scope, such as the knowledge base, workspace documents, uploaded files, or uploaded materials; and
2. a collection operation, such as count, list, enumerate uploaded filenames, or ask which files were uploaded.

Generic content phrases such as “有什么用”, “有什么区别”, “有哪些问题”, “有哪些字段”, “包含哪些项”, and “什么原因” do not establish inventory intent. Title-specific requests and questions containing domain identifiers continue through agentic retrieval.

The TypeScript trigger may identify that retrieval is needed, but FastAPI remains the single owner of the final `metadata_inventory` route decision.

### Evaluation-guide ranking

Recognize Chinese evaluation guides by filename and content, including `语料索引`, `测试指南`, `语料索引与测试指南`, and equivalent existing English markers.

For ordinary business questions:

- classify those chunks as `evaluation_guide`;
- apply the existing guide quality and rerank penalty;
- place primary evidence before guide chunks during diverse selection;
- allow guide chunks only as fallback after primary evidence.

For explicit questions about an index, evaluation guide, test guide, or the quality of citing an index:

- treat the guide as directly requested evidence;
- do not force it behind unrelated primary documents;
- keep it eligible for Top 3 and citations.

This query-aware exception preserves cases such as “如果 RAG 只引用索引文件回答，应该如何评价？” while removing guide pollution from normal policy, formula, incident, and traceability questions.

## Rejected Alternatives

### Retrieve unconditionally

This guarantees coverage but wastes retrieval work for greetings, translation, pure writing, and simple arithmetic. The selected design keeps a narrow explicit skip path.

### Expand the positive keyword list

Adding more domain nouns would improve this corpus but remain brittle under paraphrase and new industries. Default retrieval is more stable.

### Add an LLM intent classifier

An LLM classifier adds latency, cost, availability risk, and another source of nondeterminism before retrieval. The affected boundaries are expressible with deterministic rules and regression fixtures.

### Ban the guide from all results

The guide is expected evidence for explicit index-quality questions. A global ban would trade pollution for false negatives.

## Data Flow and Ownership

1. Express checks whether RAG is enabled for the conversation.
2. `ragTrigger` skips only an explicit non-knowledge task; otherwise Express calls `/agentic-retrieve`.
3. FastAPI decides whether the request is a true file inventory request.
4. Non-inventory requests run vector, BM25, and graph retrieval.
5. The reranker classifies source roles using Chinese and English markers.
6. Diverse selection keeps guide chunks behind primary evidence unless the query explicitly requests the guide.
7. Existing evidence-quality and answer-grounding logic receives the selected results unchanged.

## Error and Cost Behavior

- Empty messages remain non-retrieval inputs.
- A retrieval failure continues to use the existing visible RAG warning and fallback path; this change does not hide downstream failures.
- Explicit skip matching must be conservative. If classification is uncertain, retrieval runs.
- No new secrets, storage fields, migrations, services, or external model calls are introduced.
- The expected cost increase is bounded to messages that previously bypassed RAG despite RAG being enabled.

## Test Strategy

### Server trigger tests

- Preserve skipping for greetings, explicit translation, explicit writing/rewriting, and simple arithmetic.
- Trigger RAG for all 50 evaluation questions.
- Trigger RAG for short enterprise questions containing identifiers, policy, responsibility, amount, fields, or version comparisons.
- Verify the new decision reasons.

### RAG inventory tests

- Keep true count/list/uploaded-file requests in `metadata_inventory`.
- Route the following through agentic retrieval:
  - `旧政策截图有什么用？`
  - `可赔停线和事实停线有什么区别？`
  - `FW-4.7.9 的已知问题有哪些？`
  - `审计证据链包含哪些项？`
  - `FW-4.8.2 新增哪些诊断字段？`
- Preserve title-specific document summary behavior.

### Guide tests

- Classify the real Chinese guide filename as `evaluation_guide`.
- Keep it out of Top 3 when at least three relevant primary documents exist.
- Preserve guide eligibility for explicit index/guide questions.
- Verify source-role metadata and rerank ordering, not only final filenames.

### Verification gates

- Focused TypeScript and Python tests pass.
- Full server and RAG suites pass.
- Production build passes.
- Static trigger audit reports 50/50 RAG-enabled evaluation questions retrieving.
- Retrieval Lab guide Top-3 count drops from 16/36 to at most 2/36.
- Retrieval Lab Top-10 expected-source recall does not fall more than two percentage points from the 89.58% baseline.
- No answer-pack file is ingested or sent in a project model prompt during verification.

## Rollout and Recovery

The change is code-only and can be rolled back without data migration. Deploy Express and FastAPI together so the new trigger and inventory/guide rules are evaluated as one behavior set. Monitor retrieval call volume, p50/p95 chat latency, `metadata_inventory` route frequency, guide Top-3 frequency, and RAG fallback warnings after rollout.

## Completion Criteria

The remediation is complete only when all three behaviors have focused regression tests, affected full suites pass, the isolated corpus remains unpolluted, the 50-question trigger gate and 36-question retrieval gate meet their thresholds, the issue document records before/after evidence, and the repository contains only intentional committed changes.

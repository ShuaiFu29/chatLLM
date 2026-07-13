# RAG Routing, Inventory Intent, and Guide Ranking Implementation Plan

**Date:** 2026-07-13

**Design:** `docs/superpowers/specs/2026-07-13-rag-routing-inventory-guide-ranking-design.md`

## Goal

Implement and verify the three approved RAG remediations without changing public API contracts or contaminating the isolated corpus with answer-pack content.

## Task 1: Default RAG trigger

Files:

- `server/src/lib/ragTrigger.ts`
- `server/test/rag-trigger.test.mjs`

Steps:

1. Add failing tests for default retrieval of the 50 enterprise evaluation questions and representative short domain questions.
2. Add explicit skip tests for greetings, translation, writing/rewriting with supplied text, and simple arithmetic.
3. Replace the default `not_needed` outcome with `default_rag` and add `explicit_skip` for narrow skip categories.
4. Build the server and run the focused trigger tests.

## Task 2: Inventory intent

Files:

- `rag-service/agentic_retrieval.py`
- `rag-service/tests/test_agentic_retrieval.py`

Steps:

1. Add failing route tests for the known `有什么/有哪些/什么区别/哪些字段/包含哪些项` content questions.
2. Preserve positive tests for knowledge-base count, uploaded filenames, and explicit lists.
3. Require a file-collection scope plus a collection count/list operation.
4. Run focused agentic-retrieval tests.

## Task 3: Query-aware guide ranking

Files:

- `rag-service/reranker.py`
- `rag-service/agentic_retrieval.py`
- `rag-service/tests/test_reranker.py`
- `rag-service/tests/test_agentic_retrieval.py`

Steps:

1. Add failing classification and ordering tests using the exact Chinese filename.
2. Add an explicit-guide-query test that preserves guide eligibility.
3. Extend guide markers and add a deterministic query-intent helper.
4. Apply guide penalty and primary-first diverse selection only for ordinary business queries.
5. Run focused reranker and agentic-retrieval tests.

## Task 4: Verification

1. Run focused Node and Python tests.
2. Run the complete Server and RAG suites.
3. Run the root test suite and production build in proportion to runtime.
4. Restart the affected services from the current commit.
5. Verify all 50 evaluation questions trigger RAG without sending expected answers.
6. Run all 36 Retrieval Lab questions and score expected sources offline.
7. Verify guide Top-3 count and Top-10 recall gates.
8. Recheck PostgreSQL, MinIO, Milvus, Elasticsearch, and Neo4j for answer-file pollution.

## Task 5: Documentation and handoff

1. Update the repository Issue with after-fix evidence.
2. Review the final diff and run `git diff --check`.
3. Commit intentional implementation, tests, Issue evidence, and plan documentation.
4. Confirm the worktree is clean and services remain healthy.

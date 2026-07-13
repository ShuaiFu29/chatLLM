# RAG Issue Causal Analysis Documentation Design

**Date:** 2026-07-14

**Status:** User-approved direction

**Scope:** Expand the causal analysis in local Issue documents 061, 062, and 063. This task changes documentation only; it does not change application behavior, tests, data, or service configuration.

## Objective

The current Issue documents identify the faulty rule but compress the explanation into one or two sentences. A reader who does not know the code cannot reconstruct how a normal user question travels through the system, where the decision becomes incorrect, which correct processing stages are then skipped, or why the final answer becomes unreliable.

Each revised Issue must explain the complete cause-and-effect chain in plain Chinese while retaining enough code-level evidence for a developer to verify every claim.

## Reader Model

The primary reader may understand RAG concepts but is not expected to read TypeScript or Python. Technical names such as `getRagTriggerDecision`, `_looks_like_inventory_query`, and `classify_source_role` may appear, but every name must be immediately explained in ordinary language.

Code fragments should be short and illustrative. The documents must explain what a condition means and what happens after it evaluates to true or false instead of assuming the reader can infer control flow from source code.

## Required Structure

Each Issue will retain its existing background, observed behavior, expected behavior, reproduction, acceptance criteria, risks, and follow-up record. Its root-cause section will be expanded with these subsections:

1. **Normal processing path:** What the system should do for this kind of question.
2. **Trigger condition:** The exact user wording, filename, or ranking condition that exposes the defect.
3. **Direct technical cause:** The faulty rule and the function that owns it, translated into plain language.
4. **Step-by-step failure chain:** User input, matched condition, chosen branch, skipped stages, produced evidence, and final user-visible result.
5. **Deeper design cause:** The mistaken assumption or missing boundary behind the faulty rule.
6. **Amplifying factors:** Conditions that make the defect frequent or make its output appear trustworthy.
7. **Why existing tests missed it:** The missing negative examples, language variants, end-to-end gates, or assertions.
8. **Business impact:** Why the result matters beyond an incorrect internal route.
9. **How the fix breaks the chain:** Which decision point changed and why the same causal path no longer completes.

Each Issue will also include one compact arrow-form causal summary so a non-technical reader can understand the entire sequence at a glance.

## Issue-Specific Causal Content

### ISSUE-061: RAG-enabled questions bypass retrieval

Explain that the conversation-level RAG switch only permits retrieval; the message-level trigger still made the final decision. The old trigger used a narrow positive allowlist and returned `not_needed` for every unmatched question. Domain questions often contain product identifiers, amounts, responsibilities, or policy details without saying “根据文档”, so 46 of 50 questions followed the default skip branch. Because retrieval never started, vector, keyword, graph, reranking, evidence verification, and citations all had no opportunity to run. A fluent base-model response could then conceal the missing evidence.

### ISSUE-062: Content questions become file inventory requests

Explain that the old inventory detector independently searched for one broad scope word and one broad operation word anywhere in the question. Words such as “文档” plus “有什么” satisfied the condition even when “有什么” asked about purpose, requirements, fields, or known problems. Once classified as inventory, the function returned early with file metadata and declared strong quality merely because files existed. It bypassed content retrieval and instructed the model to list filenames, making a wrong route appear internally successful.

### ISSUE-063: Chinese evaluation guide crowds out primary evidence

Explain that guide demotion depended on a fixed marker list. The list recognized English names and “评测指南” but not the actual filename “语料索引与测试指南”. The guide therefore received the `primary` role and avoided both the role penalty and primary-first selection guard. Its dense summary text overlaps with many questions and is retrieved repeatedly, so it occupied scarce Top-3 positions. The evaluation script used a similarly incomplete detector, which could also under-report the pollution. The fix must remain query-aware because an explicit question about the guide legitimately needs that file.

## Accuracy Rules

- Distinguish direct cause, deeper cause, and amplifying factor; do not label every contributing condition as the root cause.
- Do not claim that retrieval guarantees a correct answer. State only that retrieval supplies evidence and enables downstream verification.
- Do not blame the corpus or answer pack for behavior proven to originate in routing or ranking code.
- Do not imply that answers were ingested; the isolated evaluation used only 24 corpus files.
- Preserve the measured before-and-after values already recorded in each Issue.
- Explain why a rule was reasonable locally but unsafe at system level, rather than describing it merely as “bad logic”.

## Completion Criteria

- A non-developer can retell the full failure sequence after reading each Issue.
- A developer can map every causal claim to a named function, condition, route, or ranking stage.
- Each document explains why the defect was frequent, why it was not caught earlier, and how the implemented fix prevents recurrence.
- No placeholders, speculative causes, unsupported metrics, or contradictions with the committed implementation remain.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const {
  buildInsufficientEvidenceAnswer,
  buildGroundedAnswerMessages,
  buildRetrievalConversationContext,
  generateGroundedAnswer,
  prepareGroundedAnswer,
  streamGroundedAnswer,
} = require(path.join(serverRoot, 'dist', 'services', 'answerGeneration.js'));
const {
  buildVerificationSources,
  evaluateAnswerClaims,
  packRagAnswerContext,
} = require(path.join(serverRoot, 'dist', 'lib', 'chatSources.js'));

test('retrieval conversation context is bounded and excludes the duplicate current turn', () => {
  const newestFirst = [
    { role: 'user', content: 'current question' },
    { role: 'assistant', content: 'answer 4' },
    { role: 'user', content: 'question 4' },
    { role: 'system', content: 'internal system prompt' },
    { role: 'assistant', content: 'answer 3' },
    { role: 'user', content: 'question 3' },
    { role: 'assistant', content: 'answer 2' },
    { role: 'user', content: 'question 2' },
  ];

  assert.deepEqual(buildRetrievalConversationContext(newestFirst, 'current question'), [
    { role: 'user', content: 'question 2' },
    { role: 'assistant', content: 'answer 2' },
    { role: 'user', content: 'question 3' },
    { role: 'assistant', content: 'answer 3' },
    { role: 'user', content: 'question 4' },
    { role: 'assistant', content: 'answer 4' },
  ]);
});

test('streaming and non-streaming answer calls receive the same grounded messages', async () => {
  const calls = [];
  const client = {
    chat: {
      completions: {
        create: async (request) => {
          calls.push(request);
          if (!request.stream) return { choices: [{ message: { content: 'non-stream answer' } }] };
          return (async function* chunks() {
            yield { choices: [{ delta: { content: 'stream answer' } }] };
          }());
        },
      },
    },
  };
  const messages = buildGroundedAnswerMessages({
    systemPrompt: 'system',
    historyNewestFirst: [{ role: 'user', content: 'current question' }],
    question: 'current question',
    contextText: '[Source 1] policy.md\nThe limit is 30 days.',
  });

  assert.equal(await generateGroundedAnswer({ client, resolvedModel: 'model-a', messages, temperature: 0 }), 'non-stream answer');
  const stream = await streamGroundedAnswer({ client, resolvedModel: 'model-a', messages, temperature: 0 });
  for await (const _chunk of stream) { /* consume */ }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].messages, calls[1].messages);
  assert.match(calls[0].messages.at(-1).content, /\[Source 1\]/);
  assert.equal(calls[0].messages.filter((message) => message.role === 'user').length, 1);
});

test('empty RAG context preserves fail-closed guidance instead of forwarding the raw question', () => {
  const messages = buildGroundedAnswerMessages({
    systemPrompt: 'system',
    historyNewestFirst: [],
    question: 'What is the private launch code?',
    contextText: '',
    answerGuidance: 'Retrieved evidence is insufficient. Refuse to answer.',
  });
  const prompt = messages.at(-1).content;

  assert.match(prompt, /Retrieved evidence is insufficient/);
  assert.match(prompt, /Do not answer the question from general knowledge/);
  assert.match(prompt, /No workspace evidence is available/);
  assert.notEqual(prompt, 'What is the private launch code?');
});

test('deterministic insufficient-evidence answer follows the question language', () => {
  assert.match(buildInsufficientEvidenceAnswer('发布版本是什么？'), /工作区资料不足/);
  assert.match(buildInsufficientEvidenceAnswer('What is the launch version?'), /source material is insufficient/);
});

test('prepared answer preserves multi-format provenance in display, verification, and trace sources', async () => {
  const prepared = await prepareGroundedAnswer({
    question: 'What is the approved response window?',
    userId: 'user-1',
    retrieve: async () => ({
      run_id: 'run-1',
      mode: 'hybrid',
      planned_queries: ['approved response window'],
      results: [{
        id: 'chunk-1',
        content: 'The approved response window is T+3.',
        metadata: {
          filename: 'policy.pdf',
          file_id: 'file-1',
          chunk_index: 2,
          document_kind: 'pdf',
          conversion_generation_id: 'generation-hit-1',
          active_conversion_generation_id: 'generation-active-pointer-must-not-leak',
          source_unit_ids: ['u_11111111111111111111111111111111'],
          source_locator: {
            type: 'pdf',
            page_start: 7,
            page_end: 7,
            locators: [{ type: 'pdf', kind: 'page_text', page: 7, block: 1 }],
          },
        },
        similarity: 0.92,
      }],
      trace_steps: [],
      quality: {
        retrieval_score: 0.9,
        citation_score: 0.9,
        evidence_score: 0.9,
        overall_score: 0.9,
        evidence_label: 'strong',
      },
    }),
  });
  const contextStep = prepared.traceSummary.trace_steps.at(-1);
  const mappedSources = [
    prepared.assistantSources[0],
    prepared.verificationSources[0],
    contextStep.output.source_map[0],
  ];

  for (const source of mappedSources) {
    assert.equal(source.document_kind, 'pdf');
    assert.equal(source.conversion_generation_id, 'generation-hit-1');
    assert.deepEqual(source.source_unit_ids, ['u_11111111111111111111111111111111']);
    assert.deepEqual(source.source_locator, {
      type: 'pdf',
      page_start: 7,
      page_end: 7,
      locators: [{ type: 'pdf', kind: 'page_text', page: 7, block: 1 }],
    });
    assert.equal(Object.hasOwn(source, 'active_conversion_generation_id'), false);
  }
});

test('token context packing deduplicates passages and claim metrics reject number and polarity conflicts', () => {
  const packed = packRagAnswerContext([
    {
      id: 'a-1',
      content: 'Policy FW-4.8.2 requires a 30 day review and does not permit automatic approval.',
      metadata: { filename: 'a.md', file_id: 'a', heading: 'Review', parent_title: 'Policy' },
    },
    {
      id: 'a-duplicate',
      content: 'Policy FW-4.8.2 requires a 30 day review and does not permit automatic approval.',
      metadata: { filename: 'a.md', file_id: 'a' },
    },
    {
      id: 'b-1',
      content: 'The escalation window is T+3.',
      metadata: { filename: 'b.md', file_id: 'b' },
    },
  ], 120);

  assert.equal(packed.documents.length, 2);
  assert.ok(packed.estimated_tokens <= packed.budget_tokens);
  assert.match(packed.text, /section: Review/);
  assert.match(packed.text, /parent: Policy/);

  const sources = buildVerificationSources(packed.documents);
  const evaluation = evaluateAnswerClaims(
    '复核周期是 45 天。[Source 1] The policy can permit automatic approval. [Source 1] 升级窗口是 T+3。[Source 2]',
    sources,
  );

  assert.equal(evaluation.claims.length, 3);
  assert.equal(evaluation.claims[0].supported, false);
  assert.match(evaluation.claims[0].reasons.join(' '), /fact_marker_mismatch/);
  assert.equal(evaluation.claims[1].supported, false);
  assert.match(evaluation.claims[1].reasons.join(' '), /polarity_mismatch/);
  assert.equal(evaluation.claims[2].supported, true);
  assert.equal(evaluation.citation_precision, 0.3333);
  assert.equal(evaluation.citation_coverage, 0.3333);
  assert.equal(evaluation.hallucination_rate, 0.6667);
});

test('claim verification cannot use facts that were truncated out of the model context', () => {
  const packed = packRagAnswerContext([{
    id: 'long-source',
    content: `${'Background material without the requested fact. '.repeat(80)}The launch version is FW-9.9.9.`,
    metadata: { filename: 'release.md', file_id: 'release', heading_path: ['Release', 'Version'] },
  }], 45);

  assert.doesNotMatch(packed.text, /FW-9\.9\.9/);
  assert.doesNotMatch(packed.documents[0].content, /FW-9\.9\.9/);
  assert.equal(packed.documents[0].metadata.context_truncated, true);
  assert.match(packed.text, /section: Release > Version/);

  const evaluation = evaluateAnswerClaims(
    'The launch version is FW-9.9.9. [Source 1]',
    buildVerificationSources(packed.documents),
  );
  assert.equal(evaluation.claims[0].supported, false);
  assert.match(evaluation.claims[0].reasons.join(' '), /fact_marker_mismatch/);
});

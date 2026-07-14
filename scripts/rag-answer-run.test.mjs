import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseSseEvents,
  prepareResumeResults,
  summarizeSseEvents,
  validateQuestionManifest,
} from './rag-answer-run.mjs';

test('validateQuestionManifest accepts questions-only input and rejects expectation leakage', () => {
  const valid = validateQuestionManifest({
    kind: 'rag-answer-questions-only',
    answerDataUsedDuringGeneration: false,
    cases: [{ id: 'E01', question: '问题？' }],
  });
  assert.deepEqual(valid, [{ id: 'E01', question: '问题？' }]);

  assert.throws(() => validateQuestionManifest({
    kind: 'rag-answer-questions-only',
    answerDataUsedDuringGeneration: false,
    cases: [{ id: 'E01', question: '问题？', expectedAnswer: '不允许进入生成进程' }],
  }), /expectation fields/i);
});

test('validateQuestionManifest rejects duplicate ids and an unsafe generation flag', () => {
  assert.throws(() => validateQuestionManifest({
    answerDataUsedDuringGeneration: true,
    cases: [{ id: 'E01', question: '问题？' }],
  }), /answer data/i);
  assert.throws(() => validateQuestionManifest({
    answerDataUsedDuringGeneration: false,
    cases: [{ id: 'E01', question: '问题一？' }, { id: 'E01', question: '问题二？' }],
  }), /duplicate/i);
});

test('parseSseEvents and summarizeSseEvents preserve initial retrieval and final verified sources', () => {
  const sse = [
    'data: {"ragRunId":"run-1","sources":[{"filename":"a.md"},{"filename":"b.md"}],"qualitySummary":{"evidence_label":"strong"},"traceSummary":{"trace_steps":[{"step_type":"answer_context_pack","output":{"source_map":[{"source_number":1,"filename":"a.md"},{"source_number":2,"filename":"b.md"}]}}]}}',
    '',
    'data: {"content":"第一段"}',
    '',
    'data: {"content":"第二段 [Source 2]"}',
    '',
    'data: {"sources":[{"filename":"b.md"}],"answerGrounding":{"status":"supported","score":0.8,"reasons":[],"model_cited_labels":[2],"pre_verification_cited_sources":[{"filename":"b.md"}],"citation_decisions":[{"source_number":2,"supported":true,"score":0.8,"reasons":[]}]}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const events = parseSseEvents(sse);
  const result = summarizeSseEvents(events);

  assert.equal(events.length, 4);
  assert.equal(result.answer, '第一段第二段 [Source 2]');
  assert.deepEqual(result.retrievedSources.map((item) => item.filename), ['a.md', 'b.md']);
  assert.deepEqual(result.finalSources.map((item) => item.filename), ['b.md']);
  assert.equal(result.answerGrounding.status, 'supported');
  assert.equal(result.ragRunId, 'run-1');
  assert.deepEqual(result.promptSourceMap.map((item) => item.filename), ['a.md', 'b.md']);
  assert.deepEqual(result.modelCitedLabels, [2]);
  assert.deepEqual(result.preVerificationCitedSources.map((item) => item.filename), ['b.md']);
  assert.equal(result.citationDecisions[0].supported, true);
});

test('prepareResumeResults keeps successes and retries prior transport failures', () => {
  assert.deepEqual(prepareResumeResults([
    { id: 'E01', answer: 'ok', error: '' },
    { id: 'E02', answer: '', error: 'HTTP 429' },
  ]), [{ id: 'E01', answer: 'ok', error: '' }]);
});

test('summarizeSseEvents records fail-closed RAG errors without fabricated answer text', () => {
  const result = summarizeSseEvents(parseSseEvents([
    'data: {"ragError":{"code":"rag_retrieval_unavailable","retryable":true}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')));

  assert.equal(result.answer, '');
  assert.deepEqual(result.ragError, { code: 'rag_retrieval_unavailable', retryable: true });
  assert.deepEqual(result.warnings, ['rag_retrieval_unavailable']);
});

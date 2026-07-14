import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildQuestionManifest,
  parseAnswerTable,
  scoreAnswerCase,
  scoreAnswerRun,
} from './rag-answer-eval.mjs';

const expectation = (overrides = {}) => ({
  id: 'E01',
  question: '响应窗口和处理结论是什么？',
  expectedAnswer: '响应确认窗口为 T+3，不能直接认定供应商承担全部责任。',
  expectedKeywords: ['T+3|3个工作日', '不能全部定责|不能认定供应商全部责任'],
  expectedSources: ['policy.md', 'supplier.md'],
  ...overrides,
});

const actual = (overrides = {}) => ({
  id: 'E01',
  question: '响应窗口和处理结论是什么？',
  answer: '响应确认应在 3 个工作日内完成；现有材料不能认定供应商全部责任。[Source 1][Source 2]',
  retrievedSources: [{ filename: 'policy.md' }, { filename: 'supplier.md' }],
  finalSources: [{ filename: 'policy.md' }, { filename: 'supplier.md' }],
  answerGrounding: { status: 'supported', score: 0.9, reasons: [] },
  ...overrides,
});

test('parseAnswerTable reads the five-column Markdown evaluation table', () => {
  const markdown = `
| 编号 | question | expected_answer | expected_keywords | expected_source_files |
| --- | --- | --- | --- | --- |
| E01 | 问题一？ | 答案一。 | 甲,乙 | a.md,b.md |
| E02 | 问题二？ | 答案二。 | 丙 | c.md |
`;

  assert.deepEqual(parseAnswerTable(markdown), [
    {
      id: 'E01',
      question: '问题一？',
      expectedAnswer: '答案一。',
      expectedKeywords: ['甲', '乙'],
      expectedSources: ['a.md', 'b.md'],
    },
    {
      id: 'E02',
      question: '问题二？',
      expectedAnswer: '答案二。',
      expectedKeywords: ['丙'],
      expectedSources: ['c.md'],
    },
  ]);
});

test('buildQuestionManifest removes every expectation field before generation', () => {
  const manifest = buildQuestionManifest([expectation()]);
  const serialized = JSON.stringify(manifest);

  assert.deepEqual(manifest.cases, [{ id: 'E01', question: '响应窗口和处理结论是什么？' }]);
  assert.equal(manifest.answerDataUsedDuringGeneration, false);
  assert.doesNotMatch(serialized, /expectedAnswer|expectedKeywords|expectedSources|供应商承担全部责任/);
});

test('scoreAnswerCase accepts declared equivalent concepts without weakening hard gates', () => {
  const result = scoreAnswerCase(expectation(), actual());

  assert.equal(result.grade, 'pass');
  assert.equal(result.requiredConceptCoverage, 1);
  assert.equal(result.numericConflict, false);
  assert.equal(result.polarityConflict, false);
  assert.deepEqual(result.reasons, []);
});

test('scoreAnswerCase marks a correct but incomplete answer partial', () => {
  const result = scoreAnswerCase(
    expectation({ expectedKeywords: ['T+3', '供应商责任', '审批限制', '当前政策'] }),
    actual({
      answer: '响应窗口为 T+3，供应商责任仍需核验。[Source 1]',
      finalSources: [{ filename: 'policy.md' }],
      answerGrounding: { status: 'partial', score: 0.5, reasons: [] },
    })
  );

  assert.equal(result.grade, 'partial');
  assert.match(result.reasons.join(' '), /missing_required_concept/);
  assert.match(result.reasons.join(' '), /citation_loss/);
});

test('scoreAnswerCase fails an unexpected numeric replacement under high lexical overlap', () => {
  const result = scoreAnswerCase(
    expectation({
      expectedAnswer: '初步金额为 86400 元，但不是最终承诺。',
      expectedKeywords: ['86400', '不是最终承诺'],
      expectedSources: ['claim.md'],
    }),
    actual({
      answer: '初步金额为 84600 元，但不是最终承诺。[Source 1]',
      retrievedSources: [{ filename: 'claim.md' }],
      finalSources: [{ filename: 'claim.md' }],
    })
  );

  assert.equal(result.grade, 'fail');
  assert.equal(result.numericConflict, true);
  assert.match(result.reasons.join(' '), /numeric_conflict/);
});

test('scoreAnswerCase treats omitted formula factors as missing coverage rather than a wrong number', () => {
  const result = scoreAnswerCase(
    expectation({
      expectedAnswer: 'CLM-P1-2026-06 按 6.0 × 30000 × 0.6 × 0.8 = 86400 元。',
      expectedKeywords: ['CLM-P1-2026-06', '6.0', '30000', '0.6', '0.8', '86400'],
      expectedSources: ['claim.md'],
    }),
    actual({
      answer: 'CLM-P1-2026-06 的初步金额是 86,400 元。[Source 1]',
      retrievedSources: [{ filename: 'claim.md' }],
      finalSources: [{ filename: 'claim.md' }],
    })
  );

  assert.equal(result.numericConflict, false);
  assert.equal(result.grade, 'partial');
});

test('scoreAnswerCase fails a conflicting version from the same version family', () => {
  const result = scoreAnswerCase(
    expectation({
      expectedAnswer: '当前版本为 FW-4.8.2。',
      expectedKeywords: ['FW-4.8.2'],
      expectedSources: ['firmware.md'],
    }),
    actual({
      answer: '当前版本为 FW-4.8.1。[Source 1]',
      retrievedSources: [{ filename: 'firmware.md' }],
      finalSources: [{ filename: 'firmware.md' }],
    })
  );

  assert.equal(result.grade, 'fail');
  assert.equal(result.versionConflict, true);
  assert.match(result.reasons.join(' '), /version_conflict/);
});

test('scoreAnswerCase fails a central polarity reversal', () => {
  const result = scoreAnswerCase(
    expectation({
      expectedAnswer: '不能作为免费换机依据。',
      expectedKeywords: ['不能免费换机'],
      expectedSources: ['policy.md'],
    }),
    actual({
      answer: '可以作为免费换机依据。[Source 1]',
      retrievedSources: [{ filename: 'policy.md' }],
      finalSources: [{ filename: 'policy.md' }],
    })
  );

  assert.equal(result.grade, 'fail');
  assert.equal(result.polarityConflict, true);
  assert.match(result.reasons.join(' '), /polarity_conflict/);
});

test('scoreAnswerCase does not turn a missing limiting clause into a polarity reversal', () => {
  const result = scoreAnswerCase(
    expectation({
      expectedAnswer: '供应商承认局部漂移，但没有承认全部停线损失。',
      expectedKeywords: ['局部漂移', '没有承认全部停线'],
      expectedSources: ['supplier.md'],
    }),
    actual({
      answer: '供应商承认局部漂移。[Source 1]',
      retrievedSources: [{ filename: 'supplier.md' }],
      finalSources: [{ filename: 'supplier.md' }],
    })
  );

  assert.equal(result.polarityConflict, false);
  assert.equal(result.grade, 'partial');
});

test('scoreAnswerCase does not treat missing identifier digits as a numeric contradiction', () => {
  const result = scoreAnswerCase(
    expectation({
      expectedAnswer: 'SN-A17-0642 关联 S-042 和 WO-26Q2-118。',
      expectedKeywords: ['SN-A17-0642', 'S-042', 'WO-26Q2-118'],
      expectedSources: ['mapping.md'],
    }),
    actual({
      answer: 'SN-A17-0642 关联 WO-26Q2-118 和 TEST-A17-W19-3321。[Source 1]',
      retrievedSources: [{ filename: 'mapping.md' }],
      finalSources: [{ filename: 'mapping.md' }],
    })
  );

  assert.equal(result.numericConflict, false);
  assert.equal(result.grade, 'partial');
});

test('scoreAnswerCase distinguishes retrieval success from final citation loss', () => {
  const result = scoreAnswerCase(expectation(), actual({
    finalSources: [],
    answerGrounding: { status: 'unsupported', score: 0.1, reasons: ['low_answer_source_overlap'] },
  }));

  assert.equal(result.retrievedSourceRecall, 1);
  assert.equal(result.finalSourceRecall, 0);
  assert.match(result.reasons.join(' '), /citation_loss/);
  assert.match(result.reasons.join(' '), /unsupported_claim/);
});

test('scoreAnswerCase attributes expected-source loss to the first failed citation stage', () => {
  const result = scoreAnswerCase(expectation(), actual({
    promptSourceMap: [
      { source_number: 1, filename: 'policy.md' },
      { source_number: 2, filename: 'supplier.md' },
    ],
    modelCitedLabels: [1, 2],
    citationDecisions: [
      { source_number: 1, supported: true },
      { source_number: 2, supported: false },
    ],
    finalSources: [{ filename: 'policy.md' }],
  }));

  assert.deepEqual(result.citationFlow, {
    obligations: 2,
    stages: { retrieved: 2, prompt: 2, modelCited: 2, verifierAccepted: 1, final: 1 },
    losses: {
      retrievalMiss: 0,
      contextOmission: 0,
      modelCitationOmission: 0,
      verifierRejection: 1,
      artifactLoss: 0,
    },
  });
  assert.match(result.reasons.join(' '), /verifier_rejection/);
});

test('scoreAnswerCase returns unscorable for missing expectations', () => {
  const result = scoreAnswerCase(null, actual());

  assert.equal(result.grade, 'unscorable');
  assert.deepEqual(result.reasons, ['missing_expectation']);
});

test('scoreAnswerCase treats a missing actual execution as fail rather than removable unscorable data', () => {
  const result = scoreAnswerCase(expectation(), null);

  assert.equal(result.grade, 'fail');
  assert.deepEqual(result.reasons, ['missing_actual_result']);
});

test('scoreAnswerCase enforces structured role-bound hard facts from the frozen contract', () => {
  const contract = {
    coreConcepts: [
      { id: 'declared_hours', alternatives: ['申报9.5小时', '申报 9.5 小时'], required: true },
      { id: 'supported_hours', alternatives: ['支持6小时', '支持 6.0 小时'], required: true },
    ],
    hardFacts: [
      { id: 'declared_role', type: 'numeric', requiredAny: ['申报9.5小时'], forbiddenAny: ['申报6小时'] },
      { id: 'supported_role', type: 'numeric', requiredAny: ['支持6小时'], forbiddenAny: ['支持9.5小时'] },
    ],
  };
  const result = scoreAnswerCase(
    expectation({ expectedKeywords: ['9.5', '6.0'] }),
    actual({ answer: '客户申报6小时，其中支持9.5小时。[Source 1]' }),
    contract
  );

  assert.equal(result.grade, 'fail');
  assert.equal(result.numericConflict, true);
  assert.match(result.reasons.join(' '), /numeric_conflict/);
});

test('scoreAnswerCase supports required-any source policy without inflating file recall', () => {
  const result = scoreAnswerCase(
    expectation({ expectedSources: ['primary.md', 'support-a.md', 'support-b.md'] }),
    actual({
      retrievedSources: [{ filename: 'primary.md' }, { filename: 'support-b.md' }],
      finalSources: [{ filename: 'primary.md' }, { filename: 'support-b.md' }],
    }),
    {
      sourcePolicy: {
        requiredAll: ['primary.md'],
        requiredAny: [['support-a.md', 'support-b.md']],
      },
    }
  );

  assert.equal(result.retrievedSourceRecall, 1);
  assert.equal(result.finalSourceRecall, 1);
});

test('scoreAnswerCase does not penalize optional context that the question did not ask for', () => {
  const result = scoreAnswerCase(
    expectation({ expectedKeywords: ['低于70%不建议关闭'] }),
    actual({ answer: '低于70%不建议关闭，应继续补齐证据。[Source 1][Source 2]' }),
    {
      coreConcepts: [
        { id: 'below', alternatives: ['低于70%不建议关闭'], required: true },
        { id: 'other_bands', alternatives: ['70%-89%', '90%以上'], required: false },
      ],
    }
  );

  assert.equal(result.requiredConceptCoverage, 1);
  assert.deepEqual(result.missingConcepts, []);
});

test('scoreAnswerCase ignores structural labels and optional numeric tiers', () => {
  const result = scoreAnswerCase(
    expectation({
      expectedAnswer: '低于 70% 不建议关闭，90%以上可作为关闭依据。',
      expectedKeywords: ['70%', '90%', '审计', '关闭依据'],
      expectedSources: ['audit.md'],
    }),
    actual({
      answer: '1. 根据[Chunk 3]，低于 70% 不建议关闭，需要补齐证据。[Source 1]',
      retrievedSources: [{ filename: 'audit.md' }],
      finalSources: [{ filename: 'audit.md' }],
    }),
    {
      coreConcepts: [
        { id: 'below', alternatives: ['低于 70% 不建议关闭'], required: true },
        { id: 'remediation', alternatives: ['补齐证据'], required: true },
        { id: 'above', alternatives: ['90%以上可作为关闭依据'], required: false },
      ],
    }
  );

  assert.equal(result.numericConflict, false);
  assert.equal(result.grade, 'pass');
});

test('scoreAnswerCase never passes while a required concept is missing', () => {
  const result = scoreAnswerCase(
    expectation({ expectedSources: ['policy.md'] }),
    actual({ retrievedSources: [{ filename: 'policy.md' }], finalSources: [{ filename: 'policy.md' }] }),
    {
      coreConcepts: [
        { id: 'a', alternatives: ['响应确认'], required: true },
        { id: 'b', alternatives: ['供应商全部责任'], required: true },
        { id: 'c', alternatives: ['3个工作日'], required: true },
        { id: 'missing', alternatives: ['必须保留的限制'], required: true },
      ],
    }
  );

  assert.equal(result.requiredConceptCoverage, 0.75);
  assert.notEqual(result.grade, 'pass');
});

test('scoreAnswerCase can require complete source obligations before passing', () => {
  const result = scoreAnswerCase(
    expectation({ expectedSources: ['a.md', 'b.md'] }),
    actual({
      answer: '响应确认应在3个工作日内完成，供应商责任仍需核验。[Source 1]',
      retrievedSources: [{ filename: 'a.md' }, { filename: 'b.md' }],
      finalSources: [{ filename: 'a.md' }],
    }),
    { requireCompleteSourcesForPass: true }
  );

  assert.equal(result.finalSourceRecall, 0.5);
  assert.equal(result.grade, 'partial');
});

test('scoreAnswerRun reports deterministic aggregates and never lets a shadow judge override conflicts', () => {
  const good = actual({ shadowJudge: { label: 'unsupported', score: 0 } });
  const bad = actual({
    id: 'E02',
    answer: '可以直接认定供应商全部责任。[Source 1]',
    shadowJudge: { label: 'grounded', score: 1 },
  });
  const output = scoreAnswerRun(
    [expectation(), expectation({ id: 'E02' })],
    { results: [good, bad], config: { temperature: 0 }, isolation: { answerDataUsedDuringGeneration: false } }
  );

  assert.equal(output.summary.cases, 2);
  assert.equal(output.summary.pass, 1);
  assert.equal(output.summary.fail, 1);
  assert.equal(output.cases[1].polarityConflict, true);
  assert.equal(output.config.temperature, 0);
  assert.equal(output.isolation.answerDataUsedDuringGeneration, false);
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const {
  buildChatSources,
  buildAnswerTaskGuidance,
  buildRagContext,
  buildRagContextText,
  buildVerificationSources,
  verifyAnswerGrounding,
} = require(path.join(serverRoot, 'dist', 'lib', 'chatSources.js'));

test('buildAnswerTaskGuidance adds question-type completeness requirements without expectations', () => {
  const list = buildAnswerTaskGuidance('审计证据链包含哪些项？');
  const calculation = buildAnswerTaskGuidance('供应商建议扣款如何计算？');
  const decision = buildAnswerTaskGuidance('管理评审是否批准全平台召回？');

  assert.match(list, /enumerate every distinct/i);
  assert.match(calculation, /formula/i);
  assert.match(calculation, /intermediate/i);
  assert.match(decision, /direct yes, no, conditional/i);
  assert.doesNotMatch(`${list}${calculation}${decision}`, /expected answer|expected keyword/i);
});

test('buildAnswerTaskGuidance resolves new-versus-changed field ambiguity explicitly', () => {
  const guidance = buildAnswerTaskGuidance('FW-4.8.2 新增哪些诊断字段？');

  assert.match(guidance, /strictly new items/i);
  assert.match(guidance, /existing items whose meaning, structure, or capacity changed/i);
});

test('buildChatSources preserves basic citation fields for UI display and storage', () => {
  const sources = buildChatSources([
    {
      id: 'chunk-1',
      content: 'This is the retrieved source text that should be visible as a citation snippet.',
      metadata: {
        filename: 'guide.md',
        file_id: 'file-1',
        chunk_index: 3,
      },
      similarity: 0.87654,
    },
  ]);

  assert.deepEqual(sources, [
    {
      chunk_id: 'chunk-1',
      file_id: 'file-1',
      filename: 'guide.md',
      chunk_index: 3,
      similarity: 0.87654,
      content: 'This is the retrieved source text that should be visible as a citation snippet.',
    },
  ]);
});

test('buildChatSources truncates long citation snippets', () => {
  const longContent = 'a'.repeat(900);
  const [source] = buildChatSources([
    {
      id: 'chunk-2',
      content: longContent,
      metadata: { filename: 'long.md' },
      similarity: 0.5,
    },
  ]);

  assert.equal(source.content.length, 503);
  assert.equal(source.content.endsWith('...'), true);
});

test('buildChatSources does not expose metadata inventory rows as citations', () => {
  const sources = buildChatSources([
    {
      id: 'file:file-1',
      content: '知识库文档名称: policy.md\n文件状态: completed',
      metadata: {
        filename: 'policy.md',
        file_id: 'file-1',
        chunk_index: 0,
        retrieval_mode: 'metadata_inventory',
      },
      similarity: 1,
    },
    {
      id: 'chunk-1',
      content: 'This retrieved paragraph can support a grounded answer.',
      metadata: {
        filename: 'grounded.md',
        file_id: 'file-2',
        chunk_index: 2,
      },
      similarity: 0.73,
    },
  ]);

  assert.deepEqual(sources, [
    {
      chunk_id: 'chunk-1',
      file_id: 'file-2',
      filename: 'grounded.md',
      chunk_index: 2,
      similarity: 0.73,
      content: 'This retrieved paragraph can support a grounded answer.',
    },
  ]);
});

test('verifyAnswerGrounding marks answer as supported when it overlaps retrieved evidence', () => {
  const sources = buildChatSources([
    {
      id: 'chunk-timing',
      content: '华东 E-2 紧急等级必须并读区域附件，响应确认窗口按 T+3，不能沿用默认 T+5。',
      metadata: {
        filename: 'regional-appendix.md',
        file_id: 'file-regional',
        chunk_index: 4,
      },
      similarity: 0.91,
    },
  ]);

  const verification = verifyAnswerGrounding(
    '华东 E-2 的响应确认窗口应按 T+3，而不是默认 T+5。',
    sources,
    { support_label: 'supported', evidence_label: 'strong', overall_score: 0.9 }
  );

  assert.equal(verification.status, 'supported');
  assert.equal(verification.verified_sources.length, 1);
  assert.ok(verification.score >= 0.3);
});

test('verifyAnswerGrounding withholds citations for unsupported generated answers', () => {
  const sources = buildChatSources([
    {
      id: 'chunk-profile',
      content: '用户头像可以在个人设置页更新，资料页保存昵称和主题偏好。',
      metadata: {
        filename: 'profile.md',
        file_id: 'file-profile',
        chunk_index: 1,
      },
      similarity: 0.62,
    },
  ]);

  const verification = verifyAnswerGrounding(
    'OAuth refresh token rotation 会自动吊销旧 token 并签发新的 HttpOnly 会话。',
    sources,
    { support_label: 'partial', evidence_label: 'partial', overall_score: 0.6 }
  );

  assert.equal(verification.status, 'unsupported');
  assert.equal(verification.verified_sources.length, 0);
  assert.match(verification.reasons.join(' '), /low_answer_source_overlap/);
});

test('buildRagContextText labels source chunks and keeps inventory context out of citations only', () => {
  const context = buildRagContextText([
    {
      id: 'chunk-1',
      content: '华东 E-2 响应确认窗口按 T+3。',
      metadata: {
        filename: 'regional-appendix.md',
        file_id: 'file-regional',
        chunk_index: 4,
      },
    },
    {
      id: 'file:file-1',
      content: '知识库文档名称: inventory.md',
      metadata: {
        filename: 'inventory.md',
        retrieval_mode: 'metadata_inventory',
      },
    },
  ]);

  assert.match(context, /\[Source 1\]/);
  assert.match(context, /regional-appendix\.md/);
  assert.match(context, /chunk #5/);
  assert.match(context, /华东 E-2/);
  assert.match(context, /\[Inventory 2\]/);
  assert.match(context, /inventory\.md/);
});

test('buildRagContext fairly reserves body space for every non-empty source', () => {
  const documents = [
    { id: 'a', content: 'A'.repeat(500), metadata: { filename: 'a.md', chunk_index: 0 } },
    { id: 'b', content: 'B'.repeat(500), metadata: { filename: 'b.md', chunk_index: 0 } },
    { id: 'c', content: 'C'.repeat(500), metadata: { filename: 'c.md', chunk_index: 0 } },
  ];

  const packed = buildRagContext(documents, 360);

  assert.equal(packed.allocations.length, 3);
  assert.ok(packed.allocations.every((item) => item.included_chars > 0));
  assert.match(packed.text, /\[Source 1\] a\.md/);
  assert.match(packed.text, /\[Source 2\] b\.md/);
  assert.match(packed.text, /\[Source 3\] c\.md/);
  assert.ok(packed.text.length <= 360);
});

test('verifyAnswerGrounding uses complete verification evidence beyond the display snippet', () => {
  const documents = [{
    id: 'late-evidence',
    content: `${'无关前缀。'.repeat(130)}最终规则规定响应窗口为 T+3。`,
    metadata: { filename: 'late.md', file_id: 'late-file', chunk_index: 0 },
    similarity: 0.9,
  }];
  const displaySources = buildChatSources(documents);
  const verificationSources = buildVerificationSources(documents);

  assert.doesNotMatch(displaySources[0].content, /T\+3/);
  const result = verifyAnswerGrounding(
    '响应窗口为 T+3。[Source 1]',
    displaySources,
    { support_label: 'supported', evidence_label: 'strong' },
    false,
    verificationSources
  );

  assert.equal(result.status, 'supported');
  assert.deepEqual(result.model_cited_labels, [1]);
  assert.equal(result.verified_sources.length, 1);
});

test('verifyAnswerGrounding validates each cited claim against its local source', () => {
  const documents = [
    {
      id: 'timing',
      content: '响应确认窗口为 T+3。',
      metadata: { filename: 'timing.md', file_id: 'timing', chunk_index: 0 },
    },
    {
      id: 'amount',
      content: '初步可赔金额为 86400 元，但不是最终承诺。',
      metadata: { filename: 'amount.md', file_id: 'amount', chunk_index: 0 },
    },
  ];
  const result = verifyAnswerGrounding(
    '1. 响应确认窗口为 T+3。[Source 1]\n2. 初步可赔金额为 86400 元，但不是最终承诺。[Source 2]',
    buildChatSources(documents),
    { support_label: 'supported', evidence_label: 'strong' },
    false,
    buildVerificationSources(documents)
  );

  assert.equal(result.status, 'supported');
  assert.equal(result.verified_sources.length, 2);
  assert.deepEqual(result.model_cited_labels, [1, 2]);
  assert.ok(result.citation_decisions.every((item) => item.supported));
});

test('verifyAnswerGrounding supports citations placed before the local claim', () => {
  const documents = [{
    id: 'policy',
    content: '服务站群聊只能作为线索，不能作为正式客户承诺。',
    metadata: { filename: 'policy.md', file_id: 'policy', chunk_index: 0 },
  }];
  const result = verifyAnswerGrounding(
    '根据[Source 1]，服务站群聊只能作为线索，不能作为正式客户承诺。',
    buildChatSources(documents),
    { support_label: 'supported', evidence_label: 'strong' },
    false,
    buildVerificationSources(documents)
  );

  assert.equal(result.status, 'supported');
  assert.equal(result.citation_decisions[0].supported, true);
});

test('verifyAnswerGrounding treats an evidence-limited refusal as cautious', () => {
  const documents = [{
    id: 'firmware',
    content: '固件材料只能说明版本变化，不能单独判断供应商责任。',
    metadata: { filename: 'firmware.md', file_id: 'firmware', chunk_index: 0 },
  }];
  const result = verifyAnswerGrounding(
    '仅凭固件材料不足以回答供应商责任。[Source 1]',
    buildChatSources(documents),
    { support_label: 'partial', evidence_label: 'partial' },
    true,
    buildVerificationSources(documents)
  );

  assert.equal(result.status, 'partial');
  assert.doesNotMatch(result.reasons.join(' '), /answer_not_cautious/);
});

test('verifyAnswerGrounding rejects out-of-range labels and unsupported numeric claims', () => {
  const documents = [{
    id: 'amount',
    content: '初步可赔金额为 86400 元。',
    metadata: { filename: 'amount.md', file_id: 'amount', chunk_index: 0 },
  }];
  const display = buildChatSources(documents);
  const full = buildVerificationSources(documents);

  const invalidLabel = verifyAnswerGrounding(
    '初步可赔金额为 86400 元。[Source 2]',
    display,
    { support_label: 'supported', evidence_label: 'strong' },
    false,
    full
  );
  assert.equal(invalidLabel.status, 'unsupported');
  assert.match(invalidLabel.reasons.join(' '), /invalid_citation_label/);

  const wrongNumber = verifyAnswerGrounding(
    '初步可赔金额为 84600 元。[Source 1]',
    display,
    { support_label: 'supported', evidence_label: 'strong' },
    false,
    full
  );
  assert.equal(wrongNumber.status, 'unsupported');
  assert.match(wrongNumber.reasons.join(' '), /missing_claim_markers_in_source/);
});

test('verifyAnswerGrounding rejects a citation whose source states the opposite polarity', () => {
  const documents = [{
    id: 'policy',
    content: '旧政策不能作为免费换机依据。',
    metadata: { filename: 'policy.md', file_id: 'policy', chunk_index: 0 },
  }];
  const result = verifyAnswerGrounding(
    '旧政策可以作为免费换机依据。[Source 1]',
    buildChatSources(documents),
    { support_label: 'supported', evidence_label: 'strong' },
    false,
    buildVerificationSources(documents)
  );

  assert.equal(result.status, 'unsupported');
  assert.match(result.reasons.join(' '), /citation_polarity_conflict/);
});

test('verifyAnswerGrounding does not treat ordinary title-case English words as fact markers', () => {
  const sources = [{
    chunk_id: 'chunk-1', file_id: 'file-1', filename: 'policy.md', chunk_index: 0, similarity: 1,
    content: '财务暂估用于月结和管理评审，不是客户赔付承诺。',
  }];
  const result = verifyAnswerGrounding(
    'No，财务暂估不等于赔付承诺 [Source 1]。',
    sources,
    { support_label: 'supported', evidence_label: 'strong' },
    false,
    sources
  );

  assert.notEqual(result.status, 'unsupported');
  assert.equal(result.citation_decisions?.[0]?.reasons.includes('missing_claim_markers_in_source'), false);
});

test('verifyAnswerGrounding attaches a trailing meta citation to the preceding formula', () => {
  const sources = [{
    chunk_id: 'chunk-1', file_id: 'file-1', filename: 'formula.md', chunk_index: 0, similarity: 1,
    content: '产测风险分 = 0.30 × 边界样本率 + 0.25 × 批次命中率 + 0.25 × 复测异常率 + 0.20 × 日志缺口率',
  }];
  const answer = '产测风险分 = 0.30 × 边界样本率 + 0.25 × 批次命中率 + 0.25 × 复测异常率 + 0.20 × 日志缺口率。\n\n这个公式直接来源于 [Source 1]。';
  const result = verifyAnswerGrounding(
    answer,
    sources,
    { support_label: 'supported', evidence_label: 'strong' },
    false,
    sources
  );

  assert.equal(result.citation_decisions?.[0]?.supported, true);
});

test('verifyAnswerGrounding attaches a citation followed by 中提到 to the following claim', () => {
  const sources = [{
    chunk_id: 'chunk-1', file_id: 'file-1', filename: '10-8D整改报告.md', chunk_index: 7, similarity: 1,
    content: '某些动作显示已完成，只表示责任人提交了措施，不表示客户赔付已经结案。',
  }];
  const result = verifyAnswerGrounding(
    '整改尚未完全关闭。[Source 1]中提到，某些动作显示已完成，只表示责任人提交了措施，不表示客户赔付已经结案。',
    sources,
    { support_label: 'supported', evidence_label: 'strong' },
    false,
    sources
  );

  assert.equal(result.citation_decisions?.[0]?.supported, true);
});

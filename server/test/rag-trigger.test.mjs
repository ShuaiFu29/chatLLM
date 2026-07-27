import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const { shouldUseRagForMessage, getRagTriggerDecision } = require(path.join(serverRoot, 'dist', 'lib', 'ragTrigger.js'));

test('RAG trigger skips generic chat and writing tasks', () => {
  assert.equal(shouldUseRagForMessage('你好，帮我写一封周报开头'), false);
  assert.equal(shouldUseRagForMessage('把这句话翻译成英文：今天下午开会'), false);
  assert.equal(shouldUseRagForMessage('1 + 1 等于多少？'), false);
  assert.equal(getRagTriggerDecision('你好').reason, 'explicit_skip');
  assert.equal(getRagTriggerDecision('请把以下内容润色一下：项目今天上线').reason, 'explicit_skip');
});

test('RAG trigger retrieves ambiguous and domain questions by default', () => {
  const questions = [
    'FW-4.8.2 是否证明所有故障已经修复？',
    '供应商建议扣款如何计算？',
    '管理评审是否批准全平台召回？',
    '旧政策截图有什么用？',
    '可赔停线和事实停线有什么区别？',
    'FW-4.7.9 的已知问题有哪些？',
  ];

  for (const question of questions) {
    const decision = getRagTriggerDecision(question);
    assert.equal(decision.shouldUseRag, true, question);
    assert.equal(decision.reason, 'default_rag', question);
  }
});

test('RAG trigger does not skip mixed knowledge requests', () => {
  const questions = [
    '你好，请问当前政策范围是什么？',
    '请翻译文档中的责任条款',
    '基于当前政策写一封客户回复',
    '6.0 × 30000 × 0.6 × 0.8 为什么这样计算？',
    '2026-07-13',
  ];

  for (const question of questions) {
    assert.equal(shouldUseRagForMessage(question), true, question);
  }
});

test('RAG trigger keeps knowledge-base inventory questions in metadata route', () => {
  const decision = getRagTriggerDecision('知识库里面一共有几篇文档？');

  assert.equal(decision.shouldUseRag, true);
  assert.equal(decision.reason, 'inventory');
});

test('RAG trigger uses retrieval for explicit document-grounded questions', () => {
  assert.equal(shouldUseRagForMessage('基于上传的文档，总结一下版本兼容规则'), true);
  assert.equal(shouldUseRagForMessage('查看原文里关于资料移交清单的限制'), true);
  assert.equal(shouldUseRagForMessage('What do the uploaded documents say about audit evidence?'), true);
});

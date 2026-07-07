import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
});

test('RAG trigger keeps knowledge-base inventory questions in metadata route', () => {
  const decision = getRagTriggerDecision('知识库里面一共有几篇文档？');

  assert.equal(decision.shouldUseRag, true);
  assert.equal(decision.reason, 'inventory');
});

test('RAG trigger uses retrieval for explicit document-grounded questions', () => {
  assert.equal(shouldUseRagForMessage('基于上传的文档，总结一下 NMPA 补正意见分辨规则'), true);
  assert.equal(shouldUseRagForMessage('查看原文里关于注册资料移交清单的限制'), true);
  assert.equal(shouldUseRagForMessage('What do the uploaded documents say about audit evidence?'), true);
});

test('chat controller gates RAG before calling the RAG service', () => {
  const chatSource = readFileSync(path.join(serverRoot, 'src/controllers/chat.ts'), 'utf8');

  assert.match(chatSource, /shouldUseRagForMessage/);
  assert.match(chatSource, /const shouldRunRag = enableRag && shouldUseRagForMessage\(content\)/);
  assert.match(chatSource, /if \(shouldRunRag\)/);
  assert.match(chatSource, /ragSkipped/);
});

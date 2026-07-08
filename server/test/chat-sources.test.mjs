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
  buildRagContextText,
  verifyAnswerGrounding,
} = require(path.join(serverRoot, 'dist', 'lib', 'chatSources.js'));

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

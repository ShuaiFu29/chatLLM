import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from './node_modules/typescript/lib/typescript.js';

async function importTypeScriptModule(relativePath) {
  const filePath = path.resolve(import.meta.dirname, relativePath);
  const source = readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
    fileName: filePath,
  });
  const encoded = Buffer.from(compiled.outputText, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

const { buildConversationMarkdown, createConversationExportFilename } =
  await importTypeScriptModule('src/lib/exportConversation.ts');

test('buildConversationMarkdown exports metadata, messages, and sources', () => {
  const markdown = buildConversationMarkdown({
    conversation: {
      id: 'conv-1',
      title: 'Java冒泡排序实现',
      model: 'deepseek-chat',
      created_at: '2026-06-28T08:00:00.000Z',
      updated_at: '2026-06-28T08:05:00.000Z',
    },
    workspaceName: 'General',
    exportedAt: '2026-06-28T09:00:00.000Z',
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: '请写 Java 冒泡排序',
        created_at: '2026-06-28T08:01:00.000Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '下面是一个简单实现。',
        created_at: '2026-06-28T08:02:00.000Z',
        sources: [
          {
            filename: 'sorting.md',
            chunk_index: 2,
            similarity: 0.873,
            content: 'Bubble sort repeatedly swaps adjacent elements.',
          },
        ],
      },
    ],
  });

  assert.match(markdown, /^# Java冒泡排序实现/m);
  assert.match(markdown, /Workspace: General/);
  assert.match(markdown, /Model: DeepSeek-V3/);
  assert.match(markdown, /## User/);
  assert.match(markdown, /请写 Java 冒泡排序/);
  assert.match(markdown, /## Assistant/);
  assert.match(markdown, /下面是一个简单实现。/);
  assert.match(markdown, /### Sources/);
  assert.match(markdown, /sorting\.md/);
  assert.match(markdown, /0\.873/);
  assert.match(markdown, /> Bubble sort repeatedly swaps adjacent elements\./);
});

test('createConversationExportFilename creates a safe markdown filename', () => {
  assert.equal(
    createConversationExportFilename('Java 冒泡/排序:实现', '2026-06-28T09:00:00.000Z'),
    'chatllm-2026-06-28-java-冒泡-排序-实现.md',
  );
});

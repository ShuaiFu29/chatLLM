import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const { buildChatSources } = require(path.join(serverRoot, 'dist', 'lib', 'chatSources.js'));

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

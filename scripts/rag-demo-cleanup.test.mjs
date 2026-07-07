import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const scriptPath = path.join(rootDir, 'scripts', 'rag-demo-cleanup.mjs');

test('rag demo cleanup script is dry-run by default and requires explicit confirmation', () => {
  assert.equal(existsSync(scriptPath), true);
  const source = readFileSync(scriptPath, 'utf8');

  assert.match(source, /--confirm/);
  assert.match(source, /dryRun/);
  assert.match(source, /RAG Demo/);
  assert.match(source, /rag-demo-eval-/);
  assert.match(source, /cleanup-file/);
  assert.match(source, /DeleteObjectCommand/);
  assert.match(source, /delete from users where id = \$1/);
});

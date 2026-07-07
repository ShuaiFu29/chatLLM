import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

test('rag smoke script uses local embeddings and verifies ingest retrieve cleanup', () => {
  const source = readFileSync(path.join(root, 'scripts/rag-smoke.mjs'), 'utf8');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.equal(pkg.scripts['rag:smoke'], 'node scripts/rag-smoke.mjs');
  assert.match(source, /EMBEDDING_PROVIDER:\s*'local'/);
  assert.match(source, /spawn\(/);
  assert.match(source, /\/health\/ready/);
  assert.match(source, /\/ingest-sync/);
  assert.match(source, /\/retrieve/);
  assert.match(source, /\/cleanup-file/);
  assert.match(source, /delete from users where id = \$1/);
});

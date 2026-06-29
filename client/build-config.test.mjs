import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const clientDir = path.resolve(import.meta.dirname);
const viteConfigSource = readFileSync(path.join(clientDir, 'vite.config.ts'), 'utf8');

test('compression plugins keep Windows build output readable', () => {
  assert.match(viteConfigSource, /algorithm:\s*'gzip'[\s\S]*?verbose:\s*false/);
  assert.match(viteConfigSource, /algorithm:\s*'brotliCompress'[\s\S]*?verbose:\s*false/);
});

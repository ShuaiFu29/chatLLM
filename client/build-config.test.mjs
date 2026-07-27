import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const clientDir = path.resolve(import.meta.dirname);
const viteConfigSource = readFileSync(path.join(clientDir, 'vite.config.ts'), 'utf8');

test('compression plugins keep Windows build output readable', () => {
  assert.match(viteConfigSource, /algorithm:\s*'gzip'[\s\S]*?verbose:\s*false/);
  assert.match(viteConfigSource, /algorithm:\s*'brotliCompress'[\s\S]*?verbose:\s*false/);
});

test('every favicon and PWA manifest asset exists with the declared format', () => {
  const publicDir = path.join(clientDir, 'public');
  for (const filename of [
    'favicon.ico',
    'apple-touch-icon.png',
    'masked-icon.svg',
    'pwa-192x192.png',
    'pwa-512x512.png',
  ]) {
    assert.equal(existsSync(path.join(publicDir, filename)), true, `${filename} must exist`);
    assert.match(viteConfigSource, new RegExp(filename.replaceAll('.', '\\.')));
  }

  for (const [filename, size] of [
    ['apple-touch-icon.png', 180],
    ['pwa-192x192.png', 192],
    ['pwa-512x512.png', 512],
  ]) {
    const image = readFileSync(path.join(publicDir, filename));
    assert.deepEqual(image.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
    assert.equal(image.readUInt32BE(16), size);
    assert.equal(image.readUInt32BE(20), size);
  }

  const favicon = readFileSync(path.join(publicDir, 'favicon.ico'));
  assert.deepEqual(favicon.subarray(0, 4), Buffer.from([0, 0, 1, 0]));
});

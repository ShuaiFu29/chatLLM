import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const {
  MAX_UPLOAD_CHUNKS,
  getSupportedDocumentContentType,
  parseUploadChunkIndex,
  parseUploadFileSize,
  parseUploadTotalChunks,
} = require(path.join(serverRoot, 'dist', 'lib', 'uploadInput.js'));

test('parseUploadChunkIndex accepts only bounded zero-based integer indices', () => {
  assert.equal(parseUploadChunkIndex('0'), 0);
  assert.equal(parseUploadChunkIndex('42'), 42);
  assert.equal(parseUploadChunkIndex(MAX_UPLOAD_CHUNKS - 1), MAX_UPLOAD_CHUNKS - 1);

  assert.equal(parseUploadChunkIndex('-1'), null);
  assert.equal(parseUploadChunkIndex('1abc'), null);
  assert.equal(parseUploadChunkIndex('1.5'), null);
  assert.equal(parseUploadChunkIndex(MAX_UPLOAD_CHUNKS), null);
});

test('parseUploadTotalChunks accepts only bounded positive integer counts', () => {
  assert.equal(parseUploadTotalChunks('1'), 1);
  assert.equal(parseUploadTotalChunks('42'), 42);
  assert.equal(parseUploadTotalChunks(MAX_UPLOAD_CHUNKS), MAX_UPLOAD_CHUNKS);

  assert.equal(parseUploadTotalChunks('0'), null);
  assert.equal(parseUploadTotalChunks('-1'), null);
  assert.equal(parseUploadTotalChunks('1abc'), null);
  assert.equal(parseUploadTotalChunks('1.5'), null);
  assert.equal(parseUploadTotalChunks(MAX_UPLOAD_CHUNKS + 1), null);
});

test('getSupportedDocumentContentType accepts markdown document names only', () => {
  assert.equal(getSupportedDocumentContentType('notes.md'), 'text/markdown');
  assert.equal(getSupportedDocumentContentType('notes.markdown'), 'text/markdown');
  assert.equal(getSupportedDocumentContentType('paper.PDF'), null);
  assert.equal(getSupportedDocumentContentType('notes.txt'), null);
  assert.equal(getSupportedDocumentContentType(''), null);
});

test('parseUploadFileSize enforces the configured document byte ceiling', () => {
  assert.equal(parseUploadFileSize(1, 10), 1);
  assert.equal(parseUploadFileSize('10', 10), 10);
  assert.equal(parseUploadFileSize(11, 10), null);
  assert.equal(parseUploadFileSize(Number.MAX_SAFE_INTEGER, 10), null);
});

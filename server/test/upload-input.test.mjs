import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const {
  DOCUMENT_TYPE_CAPABILITIES,
  DOCUMENT_TYPE_REGISTRY,
  MAX_UPLOAD_CHUNKS,
  SUPPORTED_DOCUMENT_ERROR,
  getSupportedDocumentContentType,
  getSupportedDocumentType,
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

test('document type registry exposes canonical MIME types for supported formats', () => {
  assert.equal(DOCUMENT_TYPE_REGISTRY.schemaVersion, 1);
  assert.deepEqual(
    DOCUMENT_TYPE_CAPABILITIES.flatMap((documentType) => documentType.extensions),
    ['md', 'markdown', 'txt', 'pdf', 'docx', 'pptx', 'xlsx', 'csv']
  );

  const cases = [
    ['notes.md', 'text/markdown', 'markdown'],
    ['notes.markdown', 'text/markdown', 'markdown'],
    ['notes.txt', 'text/plain', 'plaintext'],
    ['paper.PDF', 'application/pdf', 'pdf'],
    [
      'report.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'docx',
    ],
    [
      'slides.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'pptx',
    ],
    [
      'data.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xlsx',
    ],
    ['records.csv', 'text/csv', 'csv'],
  ];

  for (const [filename, canonicalMimeType, documentKind] of cases) {
    assert.equal(getSupportedDocumentContentType(filename), canonicalMimeType);
    assert.equal(getSupportedDocumentType(filename)?.documentKind, documentKind);
    assert.equal(Number.isSafeInteger(getSupportedDocumentType(filename)?.maxBytes), true);
    assert.equal(getSupportedDocumentType(filename).maxBytes > 0, true);
  }
});

test('document type lookup rejects legacy Office, macro, image, and ambiguous names', () => {
  for (const filename of [
    'legacy.doc',
    'legacy.xls',
    'legacy.ppt',
    'macro.docm',
    'macro.xlsm',
    'macro.pptm',
    'scan.png',
    'photo.jpg',
    'notes.md.exe',
  ]) {
    assert.equal(getSupportedDocumentContentType(filename), null);
    assert.equal(getSupportedDocumentType(filename), null);
  }

  assert.equal(getSupportedDocumentContentType(''), null);
  assert.match(SUPPORTED_DOCUMENT_ERROR, /\.md, \.markdown, \.txt, \.pdf, \.docx, \.pptx, \.xlsx, \.csv/);
});

test('parseUploadFileSize enforces the configured document byte ceiling', () => {
  assert.equal(parseUploadFileSize(1, 10), 1);
  assert.equal(parseUploadFileSize('10', 10), 10);
  assert.equal(parseUploadFileSize(11, 10), null);
  assert.equal(parseUploadFileSize(Number.MAX_SAFE_INTEGER, 10), null);
});

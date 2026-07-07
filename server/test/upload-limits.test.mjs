import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const uploadMiddleware = require(path.join(serverRoot, 'dist', 'lib', 'uploadMiddleware.js'));
const uploadErrors = require(path.join(serverRoot, 'dist', 'middleware', 'uploadErrors.js'));
const multer = require(path.join(serverRoot, 'node_modules', 'multer'));

function createResponse() {
  return {
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('document chunk upload is capped to the client chunk size', () => {
  assert.equal(uploadMiddleware.DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES, 2 * 1024 * 1024);
  assert.equal(
    uploadMiddleware.chunkUpload.limits.fileSize,
    uploadMiddleware.DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES
  );
});

test('avatar upload has an explicit bounded image size limit', () => {
  assert.equal(uploadMiddleware.AVATAR_UPLOAD_LIMIT_BYTES, 5 * 1024 * 1024);
  assert.equal(uploadMiddleware.avatarUpload.limits.fileSize, uploadMiddleware.AVATAR_UPLOAD_LIMIT_BYTES);
});

test('oversized uploads return a 413 JSON response', () => {
  const response = createResponse();
  let nextCalled = false;

  uploadErrors.handleUploadError(
    new multer.MulterError('LIMIT_FILE_SIZE'),
    {},
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 413);
  assert.equal(response.body.error, 'Uploaded file is too large');
});

test('non-upload errors are delegated to the next handler', () => {
  const response = createResponse();
  const error = new Error('Unexpected failure');
  let nextError;

  uploadErrors.handleUploadError(error, {}, response, (err) => {
    nextError = err;
  });

  assert.equal(nextError, error);
  assert.equal(response.statusCode, undefined);
});

test('merged upload integrity is verified with server-side sha256 and size checks', async () => {
  const { computeFileSha256, verifyMergedUploadFile } = require(path.join(serverRoot, 'dist', 'lib', 'uploadIntegrity.js'));
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'chatllm-upload-integrity-'));
  const filePath = path.join(tempDir, 'notes.md');

  try {
    writeFileSync(filePath, '# Notes\n\nhello');
    const digest = await computeFileSha256(filePath);

    assert.equal(digest.hash.length, 64);
    assert.equal(digest.size, Buffer.byteLength('# Notes\n\nhello'));

    await verifyMergedUploadFile(filePath, {
      expectedHash: digest.hash,
      expectedSize: digest.size,
    });

    await assert.rejects(
      () => verifyMergedUploadFile(filePath, {
        expectedHash: '0'.repeat(64),
        expectedSize: digest.size,
      }),
      /hash mismatch/i
    );

    await assert.rejects(
      () => verifyMergedUploadFile(filePath, {
        expectedHash: digest.hash,
        expectedSize: digest.size + 1,
      }),
      /size mismatch/i
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

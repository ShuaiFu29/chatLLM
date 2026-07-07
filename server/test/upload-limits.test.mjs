import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const uploadControllerSource = readFileSync(path.join(serverRoot, 'src', 'controllers', 'upload.ts'), 'utf8');

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

function withMockedUploadController(overrides = {}) {
  const controllerPath = path.join(serverRoot, 'dist', 'controllers', 'upload.js');
  const previousEntries = new Map();

  function mockModule(relativePath, exports) {
    const resolved = require.resolve(path.join(serverRoot, 'dist', relativePath));
    previousEntries.set(resolved, require.cache[resolved]);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
  }

  const resolvedController = require.resolve(controllerPath);
  previousEntries.set(resolvedController, require.cache[resolvedController]);
  delete require.cache[resolvedController];

  mockModule('repositories/files.js', {
    createUploadFile: async () => ({ id: 'upload-1' }),
    deleteFileForUser: async () => null,
    findCompletedFileByUserAndHash: async () => null,
    findFileForUser: async () => null,
    findUploadingFileByUserAndHash: async () => null,
    listFilesForUser: async () => [],
    retryFailedFileForUser: async () => null,
    updateFile: async () => null,
    ...(overrides.files || {}),
  });
  mockModule('repositories/projectSpaces.js', {
    ensureDefaultProjectSpaceForUser: async (userId) => ({ id: `default-${userId}` }),
    findProjectSpaceForUser: async () => null,
    ...(overrides.projectSpaces || {}),
  });
  mockModule('repositories/users.js', {
    findUserById: async () => null,
    updateUser: async () => null,
    ...(overrides.users || {}),
  });
  mockModule('lib/storage.js', {
    buildAvatarKey: () => 'avatar-key',
    buildDocumentKey: () => 'document-key',
    deleteObject: async () => undefined,
    getObjectStream: async () => ({ stream: null, contentType: 'text/markdown' }),
    uploadBuffer: async () => undefined,
    uploadFilePath: async () => undefined,
    ...(overrides.storage || {}),
  });
  mockModule('services/fileQueue.js', {
    fileQueue: { trigger: () => undefined },
    ...(overrides.fileQueue || {}),
  });
  mockModule('lib/ragClient.js', {
    cleanupRagFileVectors: async () => undefined,
    ...(overrides.ragClient || {}),
  });

  const controller = require(controllerPath);

  return {
    controller,
    restore() {
      for (const [resolved, entry] of previousEntries.entries()) {
        if (entry) {
          require.cache[resolved] = entry;
        } else {
          delete require.cache[resolved];
        }
      }
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

    await assert.rejects(
      () => verifyMergedUploadFile(filePath, {
        expectedHash: ' ',
        expectedSize: digest.size,
      }),
      /SHA-256 file hash/i
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('upload init rejects blank hashes before creating upload rows', async () => {
  let createCalled = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      createUploadFile: async () => {
        createCalled = true;
        return { id: 'should-not-create' };
      },
    },
  });

  try {
    const response = createResponse();
    await controller.initUpload(
      {
        user: { id: 'user-1' },
        body: {
          filename: 'notes.md',
          hash: ' ',
          size: 10,
        },
      },
      response
    );

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /SHA-256 file hash/i);
    assert.equal(createCalled, false);
  } finally {
    restore();
  }
});

test('merge integrity failures mark the upload row failed instead of leaving it uploading forever', async () => {
  const uploadId = 'integrity-failure-upload';
  const uploadDir = path.join(serverRoot, 'uploads', 'temp', uploadId);
  const mergedPath = path.join(serverRoot, 'uploads', 'temp', `${uploadId}_merged`);
  rmSync(uploadDir, { recursive: true, force: true });
  rmSync(mergedPath, { force: true });
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(path.join(uploadDir, '0'), '# tampered\n');

  let updatedFile = null;
  let uploadedToStorage = false;
  let queueTriggered = false;

  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({
        id: uploadId,
        user_id: 'user-1',
        filename: 'notes.md',
        file_hash: '0'.repeat(64),
        file_size: Buffer.byteLength('# tampered\n'),
        file_type: 'text/markdown',
        status: 'uploading',
        progress: 0,
      }),
      updateFile: async (id, updates) => {
        updatedFile = { id, updates };
        return null;
      },
    },
    storage: {
      uploadFilePath: async () => {
        uploadedToStorage = true;
      },
    },
    fileQueue: {
      fileQueue: {
        trigger: () => {
          queueTriggered = true;
        },
      },
    },
  });

  try {
    const response = createResponse();
    await controller.mergeChunks(
      {
        user: { id: 'user-1' },
        body: {
          uploadId,
          filename: 'notes.md',
          totalChunks: '1',
        },
      },
      response
    );

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /hash mismatch/i);
    assert.deepEqual(updatedFile, {
      id: uploadId,
      updates: {
        status: 'failed',
        progress: 0,
        error_message: response.body.details,
      },
    });
    assert.equal(uploadedToStorage, false);
    assert.equal(queueTriggered, false);
    assert.equal(existsSync(uploadDir), false);
    assert.equal(existsSync(mergedPath), false);
  } finally {
    restore();
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(mergedPath, { force: true });
  }
});

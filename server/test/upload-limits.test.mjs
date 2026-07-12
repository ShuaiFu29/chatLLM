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
    reserveUploadFile: async () => ({ file: { id: 'upload-1', status: 'uploading' }, created: true }),
    deleteFileForUser: async () => null,
    findClaimedFileByUserAndHash: async () => null,
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
  mockModule('services/cleanupQueue.js', {
    artifactCleanupQueue: { trigger: () => undefined },
    ...(overrides.cleanupQueue || {}),
  });
  mockModule('repositories/cleanupJobs.js', {
    enqueueFileCleanup: async () => null,
    ...(overrides.cleanupJobs || {}),
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
      reserveUploadFile: async () => {
        createCalled = true;
        return { file: { id: 'should-not-create', status: 'uploading' }, created: true };
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

test('chunk upload rejects bytes outside the file reservation before writing to disk', async () => {
  const uploadId = 'chunk-reservation-boundary';
  const uploadDir = path.join(serverRoot, 'uploads', 'temp', uploadId);
  rmSync(uploadDir, { recursive: true, force: true });
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({
        id: uploadId,
        user_id: 'user-1',
        status: 'uploading',
        file_size: 10,
        reserved_bytes: 10,
        storage_bytes: 0,
      }),
    },
  });

  try {
    const response = createResponse();
    await controller.uploadChunk({
      user: { id: 'user-1' },
      body: { uploadId, chunkIndex: '1' },
      file: { buffer: Buffer.from('overflow') },
    }, response);

    assert.equal(response.statusCode, 413);
    assert.equal(response.body.error, 'Chunk exceeds the reserved document size');
    assert.equal(existsSync(uploadDir), false);
  } finally {
    restore();
    rmSync(uploadDir, { recursive: true, force: true });
  }
});

test('upload init rejects a document above the configured maximum before reserving quota', async () => {
  const { serverEnv } = require(path.join(serverRoot, 'dist', 'lib', 'env.js'));
  let reserveCalled = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      reserveUploadFile: async () => {
        reserveCalled = true;
        return { file: { id: 'should-not-create', status: 'uploading' }, created: true };
      },
    },
  });

  try {
    assert.equal(Number.isSafeInteger(serverEnv.MAX_DOCUMENT_BYTES), true);
    const response = createResponse();
    await controller.initUpload({
      user: { id: 'user-1' },
      body: {
        filename: 'notes.md',
        hash: 'a'.repeat(64),
        size: serverEnv.MAX_DOCUMENT_BYTES + 1,
      },
    }, response);

    assert.equal(response.statusCode, 413);
    assert.equal(response.body.error, 'Document exceeds the maximum allowed size');
    assert.equal(reserveCalled, false);
  } finally {
    restore();
  }
});

test('upload init returns a stable non-reflective quota response', async () => {
  const secret = 'postgres://secret-user:secret-password@private-database/chatllm';
  const { controller, restore } = withMockedUploadController({
    files: {
      reserveUploadFile: async () => {
        throw Object.assign(new Error(secret), { code: 'USER_STORAGE_QUOTA_EXCEEDED' });
      },
    },
  });

  try {
    const response = createResponse();
    await controller.initUpload({
      user: { id: 'user-1' },
      body: { filename: 'notes.md', hash: 'a'.repeat(64), size: 10 },
    }, response);

    assert.equal(response.statusCode, 413);
    assert.deepEqual(response.body, {
      error: 'User storage quota exceeded',
      details: 'User storage quota exceeded',
    });
    assert.doesNotMatch(JSON.stringify(response.body), /secret-password|private-database/);
  } finally {
    restore();
  }
});

test('upload init reports an existing canonical file discovered inside the reservation transaction', async () => {
  const { controller, restore } = withMockedUploadController({
    files: {
      reserveUploadFile: async () => ({
        file: { id: 'canonical-file', status: 'completed' },
        created: false,
      }),
    },
  });

  try {
    const response = createResponse();
    await controller.initUpload({
      user: { id: 'user-1' },
      body: { filename: 'notes.md', hash: 'a'.repeat(64), size: 10 },
    }, response);

    assert.deepEqual(response.body, {
      exists: true,
      uploadNeeded: false,
      uploadId: 'canonical-file',
      projectSpaceId: 'default-user-1',
    });
  } finally {
    restore();
  }
});

test('upload init returns stable conflict semantics when deletion wins the reservation lock', async () => {
  for (const [code, expectedStatus, expectedMessage] of [
    ['UPLOAD_PROJECT_NOT_FOUND', 404, 'Project space not found'],
    ['UPLOAD_USER_NOT_FOUND', 409, 'Account is unavailable'],
  ]) {
    const { controller, restore } = withMockedUploadController({
      files: {
        reserveUploadFile: async () => {
          throw Object.assign(new Error('do-not-reflect'), { code });
        },
      },
    });

    try {
      const response = createResponse();
      await controller.initUpload({
        user: { id: 'user-1' },
        body: { filename: 'notes.md', hash: 'a'.repeat(64), size: 10 },
      }, response);

      assert.equal(response.statusCode, expectedStatus);
      assert.deepEqual(response.body, {
        error: expectedMessage,
        details: expectedMessage,
      });
      assert.doesNotMatch(JSON.stringify(response.body), /do-not-reflect/);
    } finally {
      restore();
    }
  }
});

test('legacy merge converts reserved bytes to measured storage bytes after integrity succeeds', async () => {
  const content = '# valid\n';
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(content).digest('hex');
  const uploadId = 'quota-success-upload';
  const uploadDir = path.join(serverRoot, 'uploads', 'temp', uploadId);
  const mergedPath = path.join(serverRoot, 'uploads', 'temp', `${uploadId}_merged`);
  rmSync(uploadDir, { recursive: true, force: true });
  rmSync(mergedPath, { force: true });
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(path.join(uploadDir, '0'), content);
  const updates = [];
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({
        id: uploadId,
        user_id: 'user-1',
        filename: 'notes.md',
        file_hash: hash,
        file_size: Buffer.byteLength(content),
        file_type: 'text/markdown',
        status: 'uploading',
        progress: 0,
        reserved_bytes: Buffer.byteLength(content),
        storage_bytes: 0,
      }),
      updateFile: async (id, values) => {
        updates.push({ id, values });
        return { id, ...values };
      },
    },
  });

  try {
    const response = createResponse();
    await controller.mergeChunks({
      user: { id: 'user-1' },
      body: { uploadId, filename: 'notes.md', totalChunks: '1' },
    }, response);

    assert.equal(response.body.success, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].values.reserved_bytes, 0);
    assert.equal(updates[0].values.storage_bytes, Buffer.byteLength(content));
  } finally {
    restore();
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(mergedPath, { force: true });
  }
});

test('upload init never exposes downstream exception text in public error details', async () => {
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  const { controller, restore } = withMockedUploadController({
    files: {
      reserveUploadFile: async () => {
        throw new Error('exception-secret-value');
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
          hash: 'a'.repeat(64),
          size: 10,
        },
      },
      response
    );

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
      error: 'Init failed',
      details: 'Init failed',
    });
    assert.doesNotMatch(JSON.stringify(response.body), /exception-secret-value/);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /exception-secret-value/);
  } finally {
    console.error = originalConsoleError;
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
        reserved_bytes: 0,
        storage_bytes: 0,
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

test('legacy merge accounts for a stored object when database queueing fails', async () => {
  const content = '# stored before database failure\n';
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(content).digest('hex');
  const uploadId = 'quota-db-failure-upload';
  const uploadDir = path.join(serverRoot, 'uploads', 'temp', uploadId);
  const mergedPath = path.join(serverRoot, 'uploads', 'temp', `${uploadId}_merged`);
  rmSync(uploadDir, { recursive: true, force: true });
  rmSync(mergedPath, { force: true });
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(path.join(uploadDir, '0'), content);
  const updates = [];
  const originalConsoleError = console.error;
  console.error = () => undefined;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({
        id: uploadId,
        user_id: 'user-1',
        filename: 'notes.md',
        file_hash: hash,
        file_size: Buffer.byteLength(content),
        file_type: 'text/markdown',
        status: 'uploading',
        progress: 0,
        reserved_bytes: Buffer.byteLength(content),
        storage_bytes: 0,
      }),
      updateFile: async (id, values) => {
        updates.push({ id, values });
        if (updates.length === 1) throw new Error('database unavailable');
        return null;
      },
    },
  });

  try {
    const response = createResponse();
    await controller.mergeChunks({
      user: { id: 'user-1' },
      body: { uploadId, filename: 'notes.md', totalChunks: '1' },
    }, response);

    assert.equal(response.statusCode, 500);
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[1].values, {
      status: 'failed',
      object_key: 'document-key',
      progress: 0,
      error_message: 'Merge failed',
      reserved_bytes: 0,
      storage_bytes: Buffer.byteLength(content),
    });
  } finally {
    console.error = originalConsoleError;
    restore();
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(mergedPath, { force: true });
  }
});

test('legacy merge requeues cleanup instead of reviving a file when deletion wins', async () => {
  const content = '# deleted while merging\n';
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(content).digest('hex');
  const uploadId = 'deletion-race-upload';
  const uploadDir = path.join(serverRoot, 'uploads', 'temp', uploadId);
  const mergedPath = path.join(serverRoot, 'uploads', 'temp', `${uploadId}_merged`);
  rmSync(uploadDir, { recursive: true, force: true });
  rmSync(mergedPath, { force: true });
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(path.join(uploadDir, '0'), content);

  let fileQueueTriggered = false;
  let cleanupQueueTriggered = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({
        id: uploadId,
        user_id: 'user-1',
        filename: 'notes.md',
        file_hash: hash,
        file_size: Buffer.byteLength(content),
        file_type: 'text/markdown',
        status: 'uploading',
        progress: 0,
      }),
      updateFile: async () => null,
    },
    fileQueue: {
      fileQueue: { trigger: () => { fileQueueTriggered = true; } },
    },
    cleanupQueue: {
      artifactCleanupQueue: { trigger: () => { cleanupQueueTriggered = true; } },
    },
  });

  try {
    const response = createResponse();
    await controller.mergeChunks({
      user: { id: 'user-1' },
      body: { uploadId, filename: 'notes.md', totalChunks: '1' },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, {
      error: 'Upload was deleted while finalizing',
      details: 'Upload was deleted while finalizing',
    });
    assert.equal(fileQueueTriggered, false);
    assert.equal(cleanupQueueTriggered, true);
    assert.equal(existsSync(uploadDir), false);
    assert.equal(existsSync(mergedPath), false);
  } finally {
    restore();
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(mergedPath, { force: true });
  }
});

test('legacy chunk merge streams chunk files instead of buffering entire uploads', () => {
  const mergeBody = uploadControllerSource.split('export const mergeChunks')[1].split('export const listFiles')[0];

  assert.match(mergeBody, /pipeline/);
  assert.match(mergeBody, /fs\.createReadStream\(chunkPath\)/);
  assert.doesNotMatch(mergeBody, /await fs\.readFile\(chunkPath\)/);
  assert.match(mergeBody, /await fs\.remove\(chunkDir\)/);
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ||= 'postgres://chatllm:chatllm@localhost:5432/chatllm';
process.env.S3_ENDPOINT ||= 'http://localhost:9000';
process.env.S3_ACCESS_KEY ||= 'minioadmin';
process.env.S3_SECRET_KEY ||= 'minioadmin';
process.env.JWT_SECRET ||= 'local-random-secret-with-more-than-32-characters';
process.env.DEEPSEEK_API_KEY ||= 'sk-test';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

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
    createUploadFile: async () => ({ id: 'file-1' }),
    reserveUploadFile: async () => ({ file: { id: 'file-1', status: 'uploading' }, created: true }),
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
  mockModule('repositories/uploadMultipart.js', {
    claimMultipartUploadAbort: async () => null,
    claimMultipartUploadCompletion: async () => null,
    createMultipartUploadSession: async () => null,
    finalizeMultipartUploadAbort: async () => null,
    finalizeMultipartUploadCompletion: async () => null,
    finalizeMultipartUploadFailure: async () => null,
    findActiveMultipartUploadSession: async () => null,
    findMultipartUploadSessionForUser: async () => null,
    markMultipartUploadAbortRetryable: async () => null,
    markMultipartUploadCompletionRetryable: async () => null,
    markMultipartUploadSessionCancelled: async () => null,
    markMultipartUploadSessionCompleted: async () => null,
    markMultipartUploadSessionCompleting: async () => null,
    markMultipartUploadSessionFailed: async () => null,
    markMultipartUploadSessionUploading: async () => ({
      file_id: 'file-1',
      user_id: 'user-1',
      object_key: 'document-key',
      storage_upload_id: 'storage-upload-1',
      part_size: 10,
      total_parts: 2,
      status: 'uploading',
      expires_at: '2099-01-01T00:00:00.000Z',
    }),
    reclaimMultipartUploadCompletion: async () => null,
    releaseMultipartUploadCompletion: async () => null,
    ...(overrides.multipart || {}),
  });
  mockModule('repositories/users.js', {
    findUserById: async () => null,
    updateUser: async () => null,
    ...(overrides.users || {}),
  });
  mockModule('lib/storage.js', {
    abortMultipartObjectUpload: async () => undefined,
    buildAvatarKey: () => 'avatar-key',
    buildDocumentKey: () => 'document-key',
    completeMultipartObjectUpload: async () => undefined,
    createMultipartObjectUpload: async () => 'storage-upload-1',
    deleteObject: async () => undefined,
    getObjectStream: async () => ({ stream: null, contentType: 'text/markdown' }),
    headObjectMetadata: async () => ({ size: 12, metadata: { sha256: 'a'.repeat(64), size: '12' } }),
    isMultipartUploadMissingError: (error) => error?.name === 'NoSuchUpload',
    isObjectNotFoundError: (error) => error?.name === 'NotFound',
    isStorageClientError: (error) => {
      const status = error?.$metadata?.httpStatusCode;
      return Number.isInteger(status) && status >= 400 && status < 500;
    },
    listMultipartObjectParts: async () => [],
    presignMultipartUploadParts: async () => [],
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

function withMockedMaintenance(overrides = {}) {
  const maintenancePath = path.join(serverRoot, 'dist', 'services', 'maintenance.js');
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

  const resolvedMaintenance = require.resolve(maintenancePath);
  previousEntries.set(resolvedMaintenance, require.cache[resolvedMaintenance]);
  delete require.cache[resolvedMaintenance];

  mockModule('repositories/ragEval.js', {
    failStaleRunningRagEvalRuns: async () => 0,
    resetStaleRagEvalRunJobs: async () => 0,
  });
  mockModule('repositories/sessions.js', { deleteExpiredSessions: async () => 0 });
  mockModule('repositories/rateLimits.js', { deleteExpiredRateLimitBuckets: async () => 0 });
  mockModule('lib/storage.js', {
    abortMultipartObjectUpload: async () => undefined,
    isMultipartUploadMissingError: () => false,
    ...(overrides.storage || {}),
  });
  mockModule('repositories/uploadMultipart.js', {
    claimMultipartUploadAbort: async () => null,
    finalizeMultipartUploadAbort: async () => null,
    listExpiredMultipartUploadSessions: async () => [],
    markMultipartUploadAbortRetryable: async () => null,
    markMultipartUploadSessionExpired: async () => null,
    ...(overrides.multipart || {}),
  });
  mockModule('repositories/files.js', {
    deleteAbandonedUploadingFiles: async () => 0,
    updateFile: async () => null,
    ...(overrides.files || {}),
  });

  const maintenance = require(maintenancePath);
  return {
    maintenance,
    restore() {
      for (const [resolved, entry] of previousEntries.entries()) {
        if (entry) require.cache[resolved] = entry;
        else delete require.cache[resolved];
      }
    },
  };
}

test('multipart upload chooses S3-safe part sizes for very large markdown files', () => {
  const {
    MAX_MULTIPART_UPLOAD_PARTS,
    MIN_MULTIPART_PART_SIZE_BYTES,
    chooseMultipartPartSize,
    parseMultipartPartNumbers,
  } = require(path.join(serverRoot, 'dist', 'lib', 'uploadInput.js'));

  assert.equal(MIN_MULTIPART_PART_SIZE_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_MULTIPART_UPLOAD_PARTS, 10000);

  const fiftyGb = 50 * 1024 * 1024 * 1024;
  const partSize = chooseMultipartPartSize(fiftyGb, 16 * 1024 * 1024);

  assert.ok(partSize >= MIN_MULTIPART_PART_SIZE_BYTES);
  assert.ok(Math.ceil(fiftyGb / partSize) <= MAX_MULTIPART_UPLOAD_PARTS);
  assert.deepEqual(parseMultipartPartNumbers([1, '2', 10000]), [1, 2, 10000]);
  assert.equal(parseMultipartPartNumbers([0]), null);
  assert.equal(parseMultipartPartNumbers([10001]), null);
});

test('upload routes expose direct multipart endpoints beside legacy chunk fallback', () => {
  const routesSource = readFileSync(path.join(serverRoot, 'src', 'routes', 'upload.ts'), 'utf8');
  const controllerSource = readFileSync(path.join(serverRoot, 'src', 'controllers', 'upload.ts'), 'utf8');
  const migrationSource = readFileSync(path.join(serverRoot, 'migrations', '0020_direct_multipart_uploads.sql'), 'utf8');

  assert.match(routesSource, /\/multipart\/init/);
  assert.match(routesSource, /\/multipart\/parts/);
  assert.match(routesSource, /\/multipart\/complete/);
  assert.match(routesSource, /\/multipart\/abort/);
  assert.match(controllerSource, /initMultipartUpload/);
  assert.match(controllerSource, /completeMultipartUpload/);
  assert.match(controllerSource, /fileQueue\.trigger\(\)/);
  assert.match(migrationSource, /create table if not exists upload_multipart_sessions/i);
  assert.match(migrationSource, /storage_upload_id/i);
});

test('multipart completion publishes file and session state transactionally after storage succeeds', async () => {
  const calls = [];
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({
        id: 'file-1',
        user_id: 'user-1',
        filename: 'notes.md',
        file_hash: 'a'.repeat(64),
        file_size: 12,
        file_type: 'text/markdown',
        status: 'uploading',
        progress: 0,
      }),
      updateFile: async (id, updates) => {
        calls.push(['updateFile', id, updates]);
        return null;
      },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => ({
        file_id: 'file-1',
        user_id: 'user-1',
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        part_size: 16 * 1024 * 1024,
        total_parts: 1,
        status: 'uploading',
      }),
      claimMultipartUploadCompletion: async (fileId, userId) => ({
        file_id: fileId,
        user_id: userId,
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        part_size: 16 * 1024 * 1024,
        total_parts: 1,
        status: 'completing',
      }),
      finalizeMultipartUploadCompletion: async (...args) => {
        calls.push(['finalizeCompletion', ...args]);
        return { transitioned: true };
      },
    },
    storage: {
      listMultipartObjectParts: async () => ([{ partNumber: 1, etag: '"etag-1"', size: 12 }]),
      completeMultipartObjectUpload: async () => {
        calls.push(['storageComplete']);
      },
    },
    fileQueue: {
      fileQueue: {
        trigger: () => calls.push(['queueTrigger']),
      },
    },
  });

  try {
    const response = createResponse();
    await controller.completeMultipartUpload(
      {
        user: { id: 'user-1' },
        body: {
          uploadId: 'file-1',
        },
      },
      response
    );

    assert.equal(response.statusCode, undefined);
    assert.equal(response.body.success, true);
    assert.deepEqual(calls, [
      ['storageComplete'],
      [
        'finalizeCompletion',
        'file-1',
        'user-1',
        'users/user-1/files/file-1/notes.md',
        12,
      ],
      ['queueTrigger'],
    ]);
  } finally {
    restore();
  }
});

test('multipart completion validation failure releases the claim without failing the file', async () => {
  const calls = [];
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({
        id: 'file-1',
        user_id: 'user-1',
        filename: 'notes.md',
        file_hash: 'a'.repeat(64),
        file_size: 12,
        file_type: 'text/markdown',
        status: 'uploading',
        progress: 0,
      }),
      updateFile: async () => { throw new Error('validation must not fail the reserved file'); },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => ({
        file_id: 'file-1',
        user_id: 'user-1',
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        part_size: 16 * 1024 * 1024,
        total_parts: 2,
        status: 'uploading',
      }),
      claimMultipartUploadCompletion: async (fileId, userId) => ({
        file_id: fileId,
        user_id: userId,
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        total_parts: 2,
        status: 'completing',
      }),
      releaseMultipartUploadCompletion: async (fileId, userId, message) => {
        calls.push(['sessionReleased', fileId, userId, message]);
      },
    },
    storage: {
      listMultipartObjectParts: async () => ([{ partNumber: 1, etag: '"etag-1"', size: 12 }]),
      completeMultipartObjectUpload: async () => {
        calls.push(['storageComplete']);
      },
    },
    fileQueue: {
      fileQueue: {
        trigger: () => calls.push(['queueTrigger']),
      },
    },
  });

  try {
    const response = createResponse();
    await controller.completeMultipartUpload(
      {
        user: { id: 'user-1' },
        body: {
          uploadId: 'file-1',
        },
      },
      response
    );

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /Missing uploaded parts/i);
    assert.equal(calls.some(([name]) => name === 'storageComplete'), false);
    assert.equal(calls.some(([name]) => name === 'queueTrigger'), false);
    assert.deepEqual(calls, [[
      'sessionReleased',
      'file-1',
      'user-1',
      response.body.details,
    ]]);
  } finally {
    restore();
  }
});

test('multipart completion rejects completed part sets whose storage size does not match the declared file size', async () => {
  const calls = [];
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({
        id: 'file-1',
        user_id: 'user-1',
        filename: 'notes.md',
        file_hash: 'a'.repeat(64),
        file_size: 12,
        file_type: 'text/markdown',
        status: 'uploading',
        progress: 0,
      }),
      updateFile: async () => { throw new Error('validation must not fail the reserved file'); },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => ({
        file_id: 'file-1',
        user_id: 'user-1',
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        part_size: 16 * 1024 * 1024,
        total_parts: 1,
        status: 'uploading',
      }),
      claimMultipartUploadCompletion: async (fileId, userId) => ({
        file_id: fileId,
        user_id: userId,
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        part_size: 16 * 1024 * 1024,
        total_parts: 1,
        status: 'completing',
      }),
      releaseMultipartUploadCompletion: async (fileId, userId, message) => {
        calls.push(['sessionReleased', fileId, userId, message]);
      },
    },
    storage: {
      listMultipartObjectParts: async () => ([{ partNumber: 1, etag: '"etag-1"', size: 10 }]),
      completeMultipartObjectUpload: async () => {
        calls.push(['storageComplete']);
      },
    },
    fileQueue: {
      fileQueue: {
        trigger: () => calls.push(['queueTrigger']),
      },
    },
  });

  try {
    const response = createResponse();
    await controller.completeMultipartUpload(
      {
        user: { id: 'user-1' },
        body: {
          uploadId: 'file-1',
        },
      },
      response
    );

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /size mismatch/i);
    assert.equal(calls.some(([name]) => name === 'storageComplete'), false);
    assert.equal(calls.some(([name]) => name === 'queueTrigger'), false);
    assert.deepEqual(calls[0], ['sessionReleased', 'file-1', 'user-1', response.body.details]);
  } finally {
    restore();
  }
});

test('multipart completion remains reconcilable when database finalization fails', async () => {
  const calls = [];
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logs.push(args);
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({
        id: 'file-1',
        user_id: 'user-1',
        filename: 'notes.md',
        file_hash: 'a'.repeat(64),
        file_size: 12,
        file_type: 'text/markdown',
        status: 'uploading',
        progress: 0,
      }),
      updateFile: async () => { throw new Error('controller must not publish terminal state directly'); },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => ({
        file_id: 'file-1',
        user_id: 'user-1',
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        part_size: 16 * 1024 * 1024,
        total_parts: 1,
        status: 'uploading',
      }),
      claimMultipartUploadCompletion: async (fileId, userId) => ({
        file_id: fileId,
        user_id: userId,
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        part_size: 16 * 1024 * 1024,
        total_parts: 1,
        status: 'completing',
      }),
      finalizeMultipartUploadCompletion: async (...args) => {
        calls.push(['finalizeCompletion', ...args]);
        throw new Error('database temporarily unavailable');
      },
      markMultipartUploadCompletionRetryable: async (fileId, userId, message) => {
        calls.push(['completionRetryable', fileId, userId, message]);
      },
    },
    storage: {
      listMultipartObjectParts: async () => ([{ partNumber: 1, etag: '"etag-1"', size: 12 }]),
      completeMultipartObjectUpload: async () => {
        calls.push(['storageComplete']);
      },
    },
    fileQueue: {
      fileQueue: {
        trigger: () => calls.push(['queueTrigger']),
      },
    },
  });

  try {
    const response = createResponse();
    await controller.completeMultipartUpload(
      {
        user: { id: 'user-1' },
        body: {
          uploadId: 'file-1',
        },
      },
      response
    );

    assert.equal(response.statusCode, 503);
    assert.equal(calls.some(([name]) => name === 'queueTrigger'), false);
    assert.deepEqual(calls[0], ['storageComplete']);
    assert.deepEqual(calls[1], [
      'finalizeCompletion',
      'file-1',
      'user-1',
      'users/user-1/files/file-1/notes.md',
      12,
    ]);
    assert.deepEqual(calls[2], [
      'completionRetryable',
      'file-1',
      'user-1',
      response.body.details,
    ]);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /database temporarily unavailable/);
  } finally {
    console.error = originalConsoleError;
    restore();
  }
});

test('multipart completion verifies final object metadata before publishing pending state', async () => {
  let finalized = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession('uploading'),
      claimMultipartUploadCompletion: async () => makeMultipartSession('completing'),
      finalizeMultipartUploadCompletion: async () => {
        finalized = true;
        return { transitioned: true };
      },
    },
    storage: {
      listMultipartObjectParts: async () => [{ partNumber: 1, etag: 'etag', size: 12 }],
      completeMultipartObjectUpload: async () => undefined,
      headObjectMetadata: async () => ({
        size: 12,
        metadata: { sha256: 'b'.repeat(64), size: '12' },
      }),
    },
  });

  try {
    const response = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.match(response.body.error, /integrity mismatch/i);
    assert.equal(finalized, false);
  } finally {
    restore();
  }
});

test('storage error classifiers inspect specific S3 codes behind generic SDK names', () => {
  const {
    isMultipartUploadMissingError,
    isObjectNotFoundError,
  } = require(path.join(serverRoot, 'dist', 'lib', 'storage.js'));

  assert.equal(isMultipartUploadMissingError({
    name: 'S3ServiceException',
    Code: 'NoSuchUpload',
  }), true);
  assert.equal(isObjectNotFoundError({
    name: 'S3ServiceException',
    code: 'NoSuchKey',
  }), true);
});

test('multipart completion rejects part boundaries that differ from the reservation', async () => {
  let storageCompleted = false;
  let released = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession('uploading', {
        part_size: 10,
        total_parts: 2,
      }),
      claimMultipartUploadCompletion: async () => makeMultipartSession('completing', {
        part_size: 10,
        total_parts: 2,
      }),
      finalizeMultipartUploadCompletion: async () => ({ transitioned: true }),
      releaseMultipartUploadCompletion: async () => { released = true; },
    },
    storage: {
      listMultipartObjectParts: async () => [
        { partNumber: 1, etag: 'etag-1', size: 5 },
        { partNumber: 2, etag: 'etag-2', size: 7 },
      ],
      completeMultipartObjectUpload: async () => { storageCompleted = true; },
    },
  });

  try {
    const response = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, response);

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /part size mismatch/i);
    assert.equal(released, true);
    assert.equal(storageCompleted, false);
  } finally {
    restore();
  }
});

test('multipart presigning rejects part numbers outside the reserved session', async () => {
  let presignCalled = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({ id: 'file-1', user_id: 'user-1', file_size: 12 }),
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => ({
        file_id: 'file-1',
        user_id: 'user-1',
        object_key: 'document-key',
        storage_upload_id: 'storage-upload-1',
        part_size: 10,
        total_parts: 2,
        status: 'uploading',
        expires_at: '2099-01-01T00:00:00.000Z',
      }),
    },
    storage: {
      presignMultipartUploadParts: async () => {
        presignCalled = true;
        return [];
      },
    },
  });

  try {
    const response = createResponse();
    await controller.presignMultipartParts({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1', partNumbers: [3] },
    }, response);

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, 'Part number exceeds reserved upload');
    assert.equal(presignCalled, false);
  } finally {
    restore();
  }
});

test('multipart presigning stops when completion or abort wins the session race', async () => {
  let presignCalled = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession('uploading'),
      markMultipartUploadSessionUploading: async () => null,
    },
    storage: {
      presignMultipartUploadParts: async () => {
        presignCalled = true;
        return [];
      },
    },
  });

  try {
    const response = createResponse();
    await controller.presignMultipartParts({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1', partNumbers: [1] },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.equal(presignCalled, false);
  } finally {
    restore();
  }
});

test('expired multipart presigning does not publish a terminal state before storage cleanup', async () => {
  let sessionFailed = false;
  let fileUpdated = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
      updateFile: async () => { fileUpdated = true; },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession('uploading', {
        expires_at: '2000-01-01T00:00:00.000Z',
      }),
      markMultipartUploadSessionFailed: async () => { sessionFailed = true; },
    },
  });

  try {
    const response = createResponse();
    await controller.presignMultipartParts({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1', partNumbers: [1] },
    }, response);

    assert.equal(response.statusCode, 410);
    assert.equal(sessionFailed, false);
    assert.equal(fileUpdated, false);
  } finally {
    restore();
  }
});

test('multipart presigned URLs bind each part to its reserved content length', async () => {
  const calls = [];
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => ({ id: 'file-1', user_id: 'user-1', file_size: 12 }),
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => ({
        file_id: 'file-1',
        user_id: 'user-1',
        object_key: 'document-key',
        storage_upload_id: 'storage-upload-1',
        part_size: 10,
        total_parts: 2,
        status: 'uploading',
        expires_at: '2099-01-01T00:00:00.000Z',
      }),
    },
    storage: {
      presignMultipartUploadParts: async (...args) => {
        calls.push(args);
        return [];
      },
    },
  });

  try {
    const response = createResponse();
    await controller.presignMultipartParts({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1', partNumbers: [1, 2] },
    }, response);

    assert.equal(response.statusCode, undefined);
    assert.deepEqual(calls, [[
      'document-key',
      'storage-upload-1',
      [1, 2],
      900,
      { partSize: 10, fileSize: 12 },
    ]]);
    const storageSource = readFileSync(path.join(serverRoot, 'src', 'lib', 'storage.ts'), 'utf8');
    assert.match(storageSource, /ContentLength:\s*contentLength/);
  } finally {
    restore();
  }
});

test('multipart abort releases reservation only after storage confirms the upload is absent', async () => {
  const calls = [];
  const { controller, restore } = withMockedUploadController({
    files: {
      updateFile: async () => { throw new Error('terminal state must use the multipart transaction'); },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => ({
        file_id: 'file-1',
        user_id: 'user-1',
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        status: 'uploading',
      }),
      claimMultipartUploadAbort: async (fileId, userId) => ({
        file_id: fileId,
        user_id: userId,
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        status: 'cancelling',
      }),
      finalizeMultipartUploadAbort: async (...args) => {
        calls.push(['finalizeAbort', ...args]);
        return { transitioned: true };
      },
    },
    storage: {
      abortMultipartObjectUpload: async () => {
        calls.push(['storageAbort']);
      },
    },
  });

  try {
    const response = createResponse();
    await controller.abortMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, response);

    assert.equal(response.body.success, true);
    assert.deepEqual(calls, [
      ['storageAbort'],
      ['finalizeAbort', 'file-1', 'user-1', 'Multipart upload cancelled'],
    ]);
  } finally {
    restore();
  }
});

test('multipart abort keeps reservation when storage absence cannot be confirmed', async () => {
  let updateCalled = false;
  const originalConsoleError = console.error;
  console.error = () => undefined;
  const { controller, restore } = withMockedUploadController({
    files: {
      updateFile: async () => {
        updateCalled = true;
        return null;
      },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => ({
        file_id: 'file-1',
        user_id: 'user-1',
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        status: 'uploading',
      }),
      claimMultipartUploadAbort: async (fileId, userId) => ({
        file_id: fileId,
        user_id: userId,
        object_key: 'users/user-1/files/file-1/notes.md',
        storage_upload_id: 'storage-upload-1',
        status: 'cancelling',
      }),
    },
    storage: {
      abortMultipartObjectUpload: async () => {
        throw new Error('ambiguous storage failure');
      },
    },
  });

  try {
    const response = createResponse();
    await controller.abortMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, response);

    assert.equal(response.statusCode, 503);
    assert.equal(updateCalled, false);
  } finally {
    console.error = originalConsoleError;
    restore();
  }
});

const makeMultipartFile = (overrides = {}) => ({
  id: 'file-1',
  user_id: 'user-1',
  filename: 'notes.md',
  file_hash: 'a'.repeat(64),
  file_size: 12,
  file_type: 'text/markdown',
  object_key: null,
  status: 'uploading',
  progress: 0,
  reserved_bytes: 12,
  storage_bytes: 0,
  ...overrides,
});

const makeMultipartSession = (status, overrides = {}) => ({
  file_id: 'file-1',
  user_id: 'user-1',
  object_key: 'users/user-1/files/file-1/notes.md',
  storage_upload_id: 'storage-upload-1',
  part_size: 16 * 1024 * 1024,
  total_parts: 1,
  status,
  expires_at: '2099-01-01T00:00:00.000Z',
  ...overrides,
});

const notFoundError = () => Object.assign(new Error('not found'), {
  name: 'NotFound',
  $metadata: { httpStatusCode: 404 },
});

test('multipart repository defines compare-and-set claims and transactional terminal updates', () => {
  const repositorySource = readFileSync(
    path.join(serverRoot, 'src', 'repositories', 'uploadMultipart.ts'),
    'utf8',
  );
  const migrationSource = readFileSync(
    path.join(serverRoot, 'migrations', '0026_file_lifecycle_cleanup.sql'),
    'utf8',
  );

  assert.match(migrationSource, /'cancelling'/);
  assert.match(
    migrationSource,
    /upload_multipart_sessions_expires_at_idx[\s\S]*where status in \('initiated', 'uploading', 'cancelling'\)/i,
  );
  assert.match(repositorySource, /claimMultipartUploadCompletion/);
  assert.match(repositorySource, /status in \('initiated', 'uploading'\)[\s\S]*returning/i);
  assert.match(repositorySource, /claimMultipartUploadAbort/);
  assert.match(repositorySource, /set status = 'cancelling'/i);
  const markUploadingSource = repositorySource.match(
    /export const markMultipartUploadSessionUploading[\s\S]*?\n};/,
  )?.[0] || '';
  assert.match(markUploadingSource, /user_id = \$2/i);
  assert.match(repositorySource, /finalizeMultipartUploadCompletion[\s\S]*withTransaction/i);
  assert.match(repositorySource, /finalizeMultipartUploadAbort[\s\S]*withTransaction/i);
  assert.match(repositorySource, /for update/i);
});

test('multipart session creation locks and rechecks the upload row before accepting storage state', () => {
  const repositorySource = readFileSync(
    path.join(serverRoot, 'src', 'repositories', 'uploadMultipart.ts'),
    'utf8',
  );
  const createSource = repositorySource.split('export const createMultipartUploadSession', 2)[1]
    ?.split('export const findMultipartUploadSessionForUser', 1)[0] || '';

  assert.match(createSource, /withTransaction/);
  assert.match(createSource, /from files[\s\S]*status = 'uploading'[\s\S]*for update/i);
  assert.match(createSource, /MULTIPART_UPLOAD_UNAVAILABLE/);
  assert.match(createSource, /insert into upload_multipart_sessions/i);
});

test('concurrent multipart completion sends exactly one storage completion request', async () => {
  let sessionStatus = 'uploading';
  let fileStatus = 'uploading';
  let objectExists = false;
  let completeCalls = 0;
  let releaseStorageCompletion;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile({ status: fileStatus }),
      updateFile: async () => { throw new Error('controller must finalize through repository transaction'); },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession(sessionStatus),
      claimMultipartUploadCompletion: async () => {
        if (!['initiated', 'uploading'].includes(sessionStatus)) return null;
        sessionStatus = 'completing';
        return makeMultipartSession(sessionStatus);
      },
      finalizeMultipartUploadCompletion: async () => {
        sessionStatus = 'completed';
        fileStatus = 'pending';
        return { transitioned: true };
      },
    },
    storage: {
      listMultipartObjectParts: async () => [{ partNumber: 1, etag: 'etag', size: 12 }],
      completeMultipartObjectUpload: async () => {
        completeCalls += 1;
        if (completeCalls === 1) {
          await new Promise((resolve) => { releaseStorageCompletion = resolve; });
        }
        objectExists = true;
      },
      headObjectMetadata: async () => {
        if (!objectExists) throw notFoundError();
        return { size: 12, metadata: { sha256: 'a'.repeat(64), size: '12' } };
      },
    },
  });

  try {
    const firstResponse = createResponse();
    const first = controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, firstResponse);
    await new Promise((resolve) => setImmediate(resolve));

    const secondResponse = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, secondResponse);

    assert.equal(secondResponse.statusCode, 202);
    assert.equal(secondResponse.body.status, 'completing');
    assert.equal(completeCalls, 1);
    releaseStorageCompletion();
    await first;
    assert.equal(firstResponse.body.success, true);
    assert.equal(sessionStatus, 'completed');
  } finally {
    restore();
  }
});

test('completion observer does not publish a reclaim marker on transient HeadObject failure', async () => {
  let retryMarkerWrites = 0;
  const headFailure = Object.assign(new Error('temporary storage failure'), {
    name: 'InternalError',
    $metadata: { httpStatusCode: 500 },
  });
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession('completing', {
        error_message: null,
      }),
      markMultipartUploadCompletionRetryable: async () => { retryMarkerWrites += 1; },
    },
    storage: {
      headObjectMetadata: async () => { throw headFailure; },
    },
  });

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const response = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, response);

    assert.equal(response.statusCode, 503);
    assert.equal(retryMarkerWrites, 0);
  } finally {
    console.error = originalConsoleError;
    restore();
  }
});

test('abort cannot overtake a completion that already owns the session', async () => {
  let sessionStatus = 'uploading';
  let objectExists = false;
  let releaseStorageCompletion;
  let abortCalls = 0;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
      updateFile: async () => { throw new Error('terminal updates must be transactional'); },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession(sessionStatus),
      claimMultipartUploadCompletion: async () => {
        if (sessionStatus !== 'uploading') return null;
        sessionStatus = 'completing';
        return makeMultipartSession(sessionStatus);
      },
      finalizeMultipartUploadCompletion: async () => {
        sessionStatus = 'completed';
        return { transitioned: true };
      },
    },
    storage: {
      listMultipartObjectParts: async () => [{ partNumber: 1, etag: 'etag', size: 12 }],
      completeMultipartObjectUpload: async () => {
        await new Promise((resolve) => { releaseStorageCompletion = resolve; });
        objectExists = true;
      },
      headObjectMetadata: async () => {
        if (!objectExists) throw notFoundError();
        return { size: 12, metadata: { sha256: 'a'.repeat(64), size: '12' } };
      },
      abortMultipartObjectUpload: async () => { abortCalls += 1; },
    },
  });

  try {
    const completeResponse = createResponse();
    const completing = controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, completeResponse);
    await new Promise((resolve) => setImmediate(resolve));

    const abortResponse = createResponse();
    await controller.abortMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, abortResponse);

    assert.equal(abortResponse.statusCode, 409);
    assert.equal(abortCalls, 0);
    releaseStorageCompletion();
    await completing;
    assert.equal(completeResponse.body.success, true);
  } finally {
    restore();
  }
});

test('abort never downgrades an already completed multipart upload', async () => {
  let abortCalls = 0;
  let updateCalls = 0;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile({ status: 'pending', object_key: 'document-key' }),
      updateFile: async () => { updateCalls += 1; },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession('completed'),
    },
    storage: {
      abortMultipartObjectUpload: async () => { abortCalls += 1; },
    },
  });

  try {
    const response = createResponse();
    await controller.abortMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.equal(abortCalls, 0);
    assert.equal(updateCalls, 0);
  } finally {
    restore();
  }
});

test('retry reconciles an S3-completed object after database finalization failed', async () => {
  let sessionStatus = 'uploading';
  let completeCalls = 0;
  let finalizeCalls = 0;
  let directFileUpdates = 0;
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
      updateFile: async () => { directFileUpdates += 1; },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession(sessionStatus),
      claimMultipartUploadCompletion: async () => {
        sessionStatus = 'completing';
        return makeMultipartSession(sessionStatus);
      },
      finalizeMultipartUploadCompletion: async () => {
        finalizeCalls += 1;
        if (finalizeCalls === 1) throw new Error('database unavailable');
        sessionStatus = 'completed';
        return { transitioned: true };
      },
      markMultipartUploadCompletionRetryable: async () => null,
    },
    storage: {
      listMultipartObjectParts: async () => [{ partNumber: 1, etag: 'etag', size: 12 }],
      completeMultipartObjectUpload: async () => { completeCalls += 1; },
      headObjectMetadata: async () => ({
        size: 12,
        metadata: { sha256: 'a'.repeat(64), size: '12' },
      }),
    },
  });

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const firstResponse = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, firstResponse);
    assert.equal(firstResponse.statusCode, 503);
    assert.equal(sessionStatus, 'completing');

    const retryResponse = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, retryResponse);

    assert.equal(retryResponse.body.success, true);
    assert.equal(completeCalls, 1);
    assert.equal(finalizeCalls, 2);
    assert.equal(directFileUpdates, 0);
  } finally {
    console.error = originalConsoleError;
    restore();
  }
});

test('retry reclaims a completion whose previous storage call definitively returned unknown', async () => {
  let sessionStatus = 'uploading';
  let errorMessage = null;
  let completeCalls = 0;
  let finalized = false;
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const retryableMessage = 'Multipart completion is pending reconciliation';
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession(sessionStatus, {
        error_message: errorMessage,
      }),
      claimMultipartUploadCompletion: async () => {
        sessionStatus = 'completing';
        errorMessage = null;
        return makeMultipartSession(sessionStatus);
      },
      reclaimMultipartUploadCompletion: async (_fileId, _userId, expectedError) => {
        if (sessionStatus !== 'completing' || errorMessage !== expectedError) return null;
        errorMessage = null;
        return makeMultipartSession('completing');
      },
      markMultipartUploadCompletionRetryable: async (_fileId, _userId, message) => {
        errorMessage = message;
      },
      finalizeMultipartUploadCompletion: async () => {
        finalized = true;
        sessionStatus = 'completed';
        return { transitioned: true };
      },
    },
    storage: {
      listMultipartObjectParts: async () => [{ partNumber: 1, etag: 'etag', size: 12 }],
      completeMultipartObjectUpload: async () => {
        completeCalls += 1;
        if (completeCalls === 1) throw timeout;
      },
      headObjectMetadata: async () => {
        if (completeCalls < 2) throw notFoundError();
        return { size: 12, metadata: { sha256: 'a'.repeat(64), size: '12' } };
      },
    },
  });

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const firstResponse = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, firstResponse);
    assert.equal(firstResponse.statusCode, 503);
    assert.equal(errorMessage, retryableMessage);

    const retryResponse = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, retryResponse);

    assert.equal(retryResponse.body.success, true);
    assert.equal(completeCalls, 2);
    assert.equal(finalized, true);
  } finally {
    console.error = originalConsoleError;
    restore();
  }
});

test('NoSuchUpload is reconciled through the final object instead of publishing failure', async () => {
  let sessionStatus = 'uploading';
  let finalized = false;
  let directFileUpdates = 0;
  const noSuchUpload = Object.assign(new Error('missing upload'), { name: 'NoSuchUpload' });
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
      updateFile: async () => { directFileUpdates += 1; },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession(sessionStatus),
      claimMultipartUploadCompletion: async () => {
        sessionStatus = 'completing';
        return makeMultipartSession(sessionStatus);
      },
      finalizeMultipartUploadCompletion: async () => {
        finalized = true;
        sessionStatus = 'completed';
        return { transitioned: true };
      },
    },
    storage: {
      listMultipartObjectParts: async () => [{ partNumber: 1, etag: 'etag', size: 12 }],
      completeMultipartObjectUpload: async () => { throw noSuchUpload; },
      headObjectMetadata: async () => ({
        size: 12,
        metadata: { sha256: 'a'.repeat(64), size: '12' },
      }),
    },
  });

  try {
    const response = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, response);

    assert.equal(response.body.success, true);
    assert.equal(finalized, true);
    assert.equal(directFileUpdates, 0);
  } finally {
    restore();
  }
});

test('NoSuchUpload with no final object atomically fails the upload and releases its reservation', async () => {
  let sessionStatus = 'uploading';
  let failureFinalizations = 0;
  let directFileUpdates = 0;
  const noSuchUpload = Object.assign(new Error('missing upload'), { name: 'NoSuchUpload' });
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
      updateFile: async () => { directFileUpdates += 1; },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession(sessionStatus),
      claimMultipartUploadCompletion: async () => {
        sessionStatus = 'completing';
        return makeMultipartSession(sessionStatus);
      },
      finalizeMultipartUploadFailure: async () => {
        failureFinalizations += 1;
        sessionStatus = 'failed';
        return { transitioned: true };
      },
    },
    storage: {
      listMultipartObjectParts: async () => [{ partNumber: 1, etag: 'etag', size: 12 }],
      completeMultipartObjectUpload: async () => { throw noSuchUpload; },
      headObjectMetadata: async () => { throw notFoundError(); },
    },
  });

  try {
    const response = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.match(response.body.error, /no longer exists/i);
    assert.equal(sessionStatus, 'failed');
    assert.equal(failureFinalizations, 1);
    assert.equal(directFileUpdates, 0);
  } finally {
    restore();
  }
});

test('definitive storage rejection releases completion ownership for a corrected retry', async () => {
  let sessionStatus = 'uploading';
  let released = false;
  const invalidPart = Object.assign(new Error('invalid part'), {
    name: 'InvalidPart',
    $metadata: { httpStatusCode: 400 },
  });
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession(sessionStatus),
      claimMultipartUploadCompletion: async () => {
        sessionStatus = 'completing';
        return makeMultipartSession(sessionStatus);
      },
      releaseMultipartUploadCompletion: async () => {
        released = true;
        sessionStatus = 'uploading';
        return makeMultipartSession(sessionStatus);
      },
    },
    storage: {
      listMultipartObjectParts: async () => [{ partNumber: 1, etag: 'etag', size: 12 }],
      completeMultipartObjectUpload: async () => { throw invalidPart; },
      headObjectMetadata: async () => { throw notFoundError(); },
    },
  });

  try {
    const response = createResponse();
    await controller.completeMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.match(response.body.error, /rejected by storage/i);
    assert.equal(released, true);
    assert.equal(sessionStatus, 'uploading');
  } finally {
    restore();
  }
});

test('abort with an unknown storage outcome remains retryable until absence is authoritative', async () => {
  let sessionStatus = 'uploading';
  let abortCalls = 0;
  let abortFinalizations = 0;
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const noSuchUpload = Object.assign(new Error('missing upload'), { name: 'NoSuchUpload' });
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
      updateFile: async () => { throw new Error('terminal updates must be transactional'); },
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession(sessionStatus),
      claimMultipartUploadAbort: async () => {
        if (!['initiated', 'uploading'].includes(sessionStatus)) return null;
        sessionStatus = 'cancelling';
        return makeMultipartSession(sessionStatus);
      },
      finalizeMultipartUploadAbort: async () => {
        abortFinalizations += 1;
        sessionStatus = 'cancelled';
        return { transitioned: true };
      },
      markMultipartUploadAbortRetryable: async () => null,
    },
    storage: {
      abortMultipartObjectUpload: async () => {
        abortCalls += 1;
        if (abortCalls === 1) throw timeout;
        throw noSuchUpload;
      },
      headObjectMetadata: async () => { throw notFoundError(); },
    },
  });

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const firstResponse = createResponse();
    await controller.abortMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, firstResponse);
    assert.equal(firstResponse.statusCode, 503);
    assert.equal(sessionStatus, 'cancelling');
    assert.equal(abortFinalizations, 0);

    const retryResponse = createResponse();
    await controller.abortMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, retryResponse);

    assert.equal(retryResponse.body.success, true);
    assert.equal(sessionStatus, 'cancelled');
    assert.equal(abortFinalizations, 1);
  } finally {
    console.error = originalConsoleError;
    restore();
  }
});

test('abort reconciliation does not claim completion when the database transition lost', async () => {
  let retryableWrites = 0;
  const noSuchUpload = Object.assign(new Error('missing upload'), { name: 'NoSuchUpload' });
  const { controller, restore } = withMockedUploadController({
    files: {
      findFileForUser: async () => makeMultipartFile(),
    },
    multipart: {
      findMultipartUploadSessionForUser: async () => makeMultipartSession('cancelling'),
      finalizeMultipartUploadCompletion: async () => ({
        transitioned: false,
        session: makeMultipartSession('cancelled'),
      }),
      markMultipartUploadAbortRetryable: async () => { retryableWrites += 1; },
    },
    storage: {
      abortMultipartObjectUpload: async () => { throw noSuchUpload; },
      headObjectMetadata: async () => ({
        size: 12,
        metadata: { sha256: 'a'.repeat(64), size: '12' },
      }),
    },
  });

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const response = createResponse();
    await controller.abortMultipartUpload({
      user: { id: 'user-1' },
      body: { uploadId: 'file-1' },
    }, response);

    assert.equal(response.statusCode, 503);
    assert.equal(retryableWrites, 1);
  } finally {
    console.error = originalConsoleError;
    restore();
  }
});

test('concurrent multipart initialization keeps one canonical storage upload and aborts the loser', async () => {
  let activeChecks = 0;
  let releaseActiveChecks;
  const bothChecked = new Promise((resolve) => { releaseActiveChecks = resolve; });
  let storageUploadSequence = 0;
  let canonicalSession = null;
  const abortedStorageUploads = [];

  const { controller, restore } = withMockedUploadController({
    files: {
      reserveUploadFile: async () => ({
        file: { id: 'file-1', status: 'uploading' },
        created: false,
      }),
      updateFile: async () => { throw new Error('a losing initializer must not fail the canonical file'); },
    },
    multipart: {
      findActiveMultipartUploadSession: async () => {
        activeChecks += 1;
        if (activeChecks === 2) releaseActiveChecks();
        await bothChecked;
        return null;
      },
      createMultipartUploadSession: async (input) => {
        if (!canonicalSession) {
          canonicalSession = {
            file_id: input.fileId,
            user_id: input.userId,
            object_key: input.objectKey,
            storage_upload_id: input.storageUploadId,
            part_size: input.partSize,
            total_parts: input.totalParts,
            status: 'initiated',
            expires_at: input.expiresAt.toISOString(),
          };
          return { created: true, session: canonicalSession };
        }
        return { created: false, session: canonicalSession };
      },
      findMultipartUploadSessionForUser: async () => canonicalSession,
    },
    storage: {
      createMultipartObjectUpload: async () => `storage-upload-${++storageUploadSequence}`,
      abortMultipartObjectUpload: async (_key, storageUploadId) => {
        abortedStorageUploads.push(storageUploadId);
      },
      listMultipartObjectParts: async () => [],
    },
  });

  try {
    const request = {
      user: { id: 'user-1' },
      body: {
        filename: 'notes.md',
        hash: 'a'.repeat(64),
        size: 12,
        type: 'text/markdown',
      },
    };
    const firstResponse = createResponse();
    const secondResponse = createResponse();

    await Promise.all([
      controller.initMultipartUpload(request, firstResponse),
      controller.initMultipartUpload(request, secondResponse),
    ]);

    assert.equal(storageUploadSequence, 2);
    assert.equal(abortedStorageUploads.length, 1);
    assert.notEqual(abortedStorageUploads[0], canonicalSession.storage_upload_id);
    assert.equal(firstResponse.body.expiresAt, canonicalSession.expires_at);
    assert.equal(secondResponse.body.expiresAt, canonicalSession.expires_at);
  } finally {
    restore();
  }
});

test('multipart initialization aborts its new storage upload when file deletion wins', async () => {
  const abortedStorageUploads = [];
  const { controller, restore } = withMockedUploadController({
    files: {
      reserveUploadFile: async () => ({ file: makeMultipartFile(), created: false }),
    },
    multipart: {
      findActiveMultipartUploadSession: async () => null,
      createMultipartUploadSession: async () => {
        throw Object.assign(new Error('do-not-reflect'), {
          code: 'MULTIPART_UPLOAD_UNAVAILABLE',
        });
      },
    },
    storage: {
      createMultipartObjectUpload: async () => 'late-storage-upload',
      abortMultipartObjectUpload: async (_key, uploadId) => {
        abortedStorageUploads.push(uploadId);
      },
    },
  });

  try {
    const response = createResponse();
    await controller.initMultipartUpload({
      user: { id: 'user-1' },
      body: {
        filename: 'notes.md',
        hash: 'a'.repeat(64),
        size: 12,
        type: 'text/markdown',
      },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, {
      error: 'Multipart upload state changed',
      details: 'Multipart upload state changed',
    });
    assert.deepEqual(abortedStorageUploads, ['late-storage-upload']);
    assert.doesNotMatch(JSON.stringify(response.body), /do-not-reflect/);
  } finally {
    restore();
  }
});

test('losing multipart initializer refreshes canonical state after aborting its storage upload', async () => {
  let abortedLoser = false;
  let listedCanonicalParts = false;
  const staleSession = makeMultipartSession('uploading');
  const { controller, restore } = withMockedUploadController({
    files: {
      reserveUploadFile: async () => ({ file: makeMultipartFile(), created: false }),
    },
    multipart: {
      findActiveMultipartUploadSession: async () => null,
      createMultipartUploadSession: async () => ({ created: false, session: staleSession }),
      findMultipartUploadSessionForUser: async () => makeMultipartSession('completing'),
    },
    storage: {
      createMultipartObjectUpload: async () => 'losing-storage-upload',
      abortMultipartObjectUpload: async () => { abortedLoser = true; },
      listMultipartObjectParts: async () => {
        listedCanonicalParts = true;
        return [];
      },
    },
  });

  try {
    const response = createResponse();
    await controller.initMultipartUpload({
      user: { id: 'user-1' },
      body: {
        filename: 'notes.md',
        hash: 'a'.repeat(64),
        size: 12,
        type: 'text/markdown',
      },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.equal(abortedLoser, true);
    assert.equal(listedCanonicalParts, false);
  } finally {
    restore();
  }
});

test('multipart initialization rejects resumable session data while canonical completion is in progress', async () => {
  let storageTouched = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      reserveUploadFile: async () => ({ file: makeMultipartFile(), created: false }),
    },
    multipart: {
      findActiveMultipartUploadSession: async () => makeMultipartSession('completing'),
    },
    storage: {
      createMultipartObjectUpload: async () => {
        storageTouched = true;
        return 'unexpected-upload';
      },
      listMultipartObjectParts: async () => {
        storageTouched = true;
        return [];
      },
    },
  });

  try {
    const response = createResponse();
    await controller.initMultipartUpload({
      user: { id: 'user-1' },
      body: {
        filename: 'notes.md',
        hash: 'a'.repeat(64),
        size: 12,
        type: 'text/markdown',
      },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.match(response.body.error, /completion is in progress/i);
    assert.equal(storageTouched, false);
  } finally {
    restore();
  }
});

test('upload check does not advertise a completing multipart session as resumable', async () => {
  let storageTouched = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      findClaimedFileByUserAndHash: async () => makeMultipartFile(),
    },
    multipart: {
      findActiveMultipartUploadSession: async () => makeMultipartSession('completing'),
    },
    storage: {
      listMultipartObjectParts: async () => {
        storageTouched = true;
        return [];
      },
    },
  });

  try {
    const response = createResponse();
    await controller.checkFile({
      user: { id: 'user-1' },
      body: { hash: 'a'.repeat(64), filename: 'notes.md' },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.match(response.body.error, /completion is in progress/i);
    assert.equal(storageTouched, false);
  } finally {
    restore();
  }
});

test('multipart initialization waits for authoritative cleanup of an expired canonical session', async () => {
  let storageTouched = false;
  const { controller, restore } = withMockedUploadController({
    files: {
      reserveUploadFile: async () => ({ file: makeMultipartFile(), created: false }),
    },
    multipart: {
      findActiveMultipartUploadSession: async () => makeMultipartSession('uploading', {
        expires_at: '2000-01-01T00:00:00.000Z',
      }),
    },
    storage: {
      createMultipartObjectUpload: async () => {
        storageTouched = true;
        return 'unexpected-upload';
      },
      listMultipartObjectParts: async () => {
        storageTouched = true;
        return [];
      },
    },
  });

  try {
    const response = createResponse();
    await controller.initMultipartUpload({
      user: { id: 'user-1' },
      body: {
        filename: 'notes.md',
        hash: 'a'.repeat(64),
        size: 12,
        type: 'text/markdown',
      },
    }, response);

    assert.equal(response.statusCode, 410);
    assert.equal(storageTouched, false);
  } finally {
    restore();
  }
});

test('expired multipart cleanup keeps reservation retryable when storage abort is ambiguous', async () => {
  let legacyExpiredWrites = 0;
  let directFileWrites = 0;
  let retryableWrites = 0;
  let finalizations = 0;
  const session = makeMultipartSession('uploading', {
    expires_at: '2000-01-01T00:00:00.000Z',
  });
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const { maintenance, restore } = withMockedMaintenance({
    multipart: {
      listExpiredMultipartUploadSessions: async () => [session],
      claimMultipartUploadAbort: async () => makeMultipartSession('cancelling'),
      finalizeMultipartUploadAbort: async () => { finalizations += 1; },
      markMultipartUploadAbortRetryable: async () => { retryableWrites += 1; },
      markMultipartUploadSessionExpired: async () => { legacyExpiredWrites += 1; },
    },
    storage: {
      abortMultipartObjectUpload: async () => { throw timeout; },
      isMultipartUploadMissingError: () => false,
    },
    files: {
      updateFile: async () => { directFileWrites += 1; },
    },
  });

  try {
    await maintenance.cleanupExpiredMultipartUploadSessions();

    assert.equal(finalizations, 0);
    assert.equal(legacyExpiredWrites, 0);
    assert.equal(directFileWrites, 0);
    assert.equal(retryableWrites, 1);
  } finally {
    restore();
  }
});

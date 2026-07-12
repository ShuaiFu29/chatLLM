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
    createMultipartUploadSession: async () => null,
    findActiveMultipartUploadSession: async () => null,
    findMultipartUploadSessionForUser: async () => null,
    markMultipartUploadSessionCancelled: async () => null,
    markMultipartUploadSessionCompleted: async () => null,
    markMultipartUploadSessionCompleting: async () => null,
    markMultipartUploadSessionFailed: async () => null,
    markMultipartUploadSessionUploading: async () => null,
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

test('multipart completion marks the file pending only after storage completion succeeds', async () => {
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
      markMultipartUploadSessionCompleted: async (fileId) => {
        calls.push(['sessionCompleted', fileId]);
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
      ['updateFile', 'file-1', {
        status: 'pending',
        object_key: 'users/user-1/files/file-1/notes.md',
        progress: 0,
        error_message: null,
        reserved_bytes: 0,
        storage_bytes: 12,
      }],
      ['sessionCompleted', 'file-1'],
      ['queueTrigger'],
    ]);
  } finally {
    restore();
  }
});

test('multipart completion failure leaves a retryable failed upload record', async () => {
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
        total_parts: 2,
        status: 'uploading',
      }),
      markMultipartUploadSessionFailed: async (fileId, message) => {
        calls.push(['sessionFailed', fileId, message]);
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
    assert.deepEqual(calls[0], ['sessionFailed', 'file-1', response.body.details]);
    assert.deepEqual(calls[1], ['updateFile', 'file-1', {
      status: 'failed',
      progress: 0,
      error_message: response.body.details,
    }]);
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
      markMultipartUploadSessionFailed: async (fileId, message) => {
        calls.push(['sessionFailed', fileId, message]);
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
    assert.deepEqual(calls[0], ['sessionFailed', 'file-1', response.body.details]);
  } finally {
    restore();
  }
});

test('multipart completion preserves completed object key when database queueing fails', async () => {
  const calls = [];
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logs.push(args);
  let updateCount = 0;
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
        updateCount += 1;
        calls.push(['updateFile', id, updates]);
        if (updateCount === 1) {
          throw new Error('database temporarily unavailable');
        }
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
      markMultipartUploadSessionFailed: async (fileId, message) => {
        calls.push(['sessionFailed', fileId, message]);
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

    assert.equal(response.statusCode, 500);
    assert.equal(calls.some(([name]) => name === 'queueTrigger'), false);
    assert.deepEqual(calls[0], ['storageComplete']);
    assert.deepEqual(calls[2], ['sessionFailed', 'file-1', response.body.details]);
    assert.deepEqual(calls[3], ['updateFile', 'file-1', {
      status: 'failed',
      object_key: 'users/user-1/files/file-1/notes.md',
      progress: 0,
      error_message: response.body.details,
      reserved_bytes: 0,
      storage_bytes: 12,
    }]);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /database temporarily unavailable/);
  } finally {
    console.error = originalConsoleError;
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
        status: 'uploading',
      }),
      markMultipartUploadSessionCancelled: async () => {
        calls.push(['sessionCancelled']);
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
      ['sessionCancelled'],
      ['updateFile', 'file-1', {
        status: 'failed',
        progress: 0,
        error_message: 'Multipart upload cancelled',
        reserved_bytes: 0,
        storage_bytes: 0,
      }],
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

    assert.equal(response.statusCode, 500);
    assert.equal(updateCalled, false);
  } finally {
    console.error = originalConsoleError;
    restore();
  }
});

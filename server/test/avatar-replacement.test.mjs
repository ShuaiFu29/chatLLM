import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const createResponse = () => ({
  statusCode: undefined,
  body: undefined,
  sent: false,
  headers: {},
  raw: { headersSent: false },
  code(code) {
    this.statusCode = code;
    return this;
  },
  send(body) {
    this.body = body;
    this.sent = true;
    return this;
  },
  header(name, value) {
    this.headers[name.toLowerCase()] = value;
    return this;
  },
});

const avatarRequest = () => ({
  user: { id: 'user-1' },
  requestId: 'avatar-test-request',
  uploadFile: {
    originalname: 'avatar.png',
    mimetype: 'image/png',
    buffer: Buffer.from('new-avatar'),
  },
});

test('avatar object keys remain unique for concurrent requests in the same millisecond', () => {
  const { buildAvatarKey } = require(path.join(serverRoot, 'dist', 'lib', 'storage.js'));
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const first = buildAvatarKey('user-1', 'avatar.png');
    const second = buildAvatarKey('user-1', 'avatar.png');
    assert.notEqual(first, second);
    assert.match(first, /^users\/user-1\/avatars\/[0-9a-f-]+-avatar\.png$/i);
    assert.match(second, /^users\/user-1\/avatars\/[0-9a-f-]+-avatar\.png$/i);
  } finally {
    Date.now = originalNow;
  }
});

function withMockedUploadController(overrides = {}) {
  const controllerPath = path.join(serverRoot, 'dist', 'controllers', 'upload.js');
  const previousEntries = new Map();

  const mockModule = (relativePath, exports) => {
    const resolved = require.resolve(path.join(serverRoot, 'dist', relativePath));
    previousEntries.set(resolved, require.cache[resolved]);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
  };

  const resolvedController = require.resolve(controllerPath);
  previousEntries.set(resolvedController, require.cache[resolvedController]);
  delete require.cache[resolvedController];

  mockModule('repositories/files.js', {
    findClaimedFileByUserAndHash: async () => null,
    findFileForUser: async () => null,
    listFilesForUser: async () => [],
    reserveUploadFile: async () => null,
    retryFailedFileForUser: async () => null,
    updateFile: async () => null,
  });
  mockModule('repositories/projectSpaces.js', {
    ensureDefaultProjectSpaceForUser: async () => null,
    findProjectSpaceForUser: async () => null,
  });
  mockModule('repositories/users.js', {
    findUserById: async () => ({ id: 'user-1', avatar_object_key: 'old-avatar' }),
    updateUser: async () => null,
    replaceUserAvatar: async () => null,
    ...(overrides.users || {}),
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
    markMultipartUploadSessionUploading: async () => null,
    reclaimMultipartUploadCompletion: async () => null,
    releaseMultipartUploadCompletion: async () => null,
  });
  mockModule('repositories/cleanupJobs.js', {
    enqueueAvatarCleanup: async () => null,
    enqueueFileCleanup: async () => null,
    ...(overrides.cleanupJobs || {}),
  });
  mockModule('lib/storage.js', {
    abortMultipartObjectUpload: async () => undefined,
    buildAvatarKey: () => 'new-avatar',
    buildDocumentKey: () => 'document-key',
    completeMultipartObjectUpload: async () => undefined,
    createMultipartObjectUpload: async () => 'multipart-upload',
    deleteObject: async () => undefined,
    getObjectStream: async () => ({ stream: null }),
    headObjectMetadata: async () => null,
    isMultipartUploadMissingError: () => false,
    isObjectNotFoundError: () => false,
    isStorageClientError: () => false,
    listMultipartObjectParts: async () => [],
    presignMultipartUploadParts: async () => [],
    uploadBuffer: async () => undefined,
    uploadFilePath: async () => undefined,
    ...(overrides.storage || {}),
  });
  mockModule('services/fileQueue.js', {
    fileQueue: { trigger: () => undefined },
  });
  mockModule('services/cleanupQueue.js', {
    artifactCleanupQueue: { trigger: () => undefined },
    ...(overrides.cleanupQueue || {}),
  });

  const controller = require(controllerPath);
  return {
    controller,
    restore() {
      for (const [resolved, entry] of previousEntries.entries()) {
        if (entry) require.cache[resolved] = entry;
        else delete require.cache[resolved];
      }
    },
  };
}

test('avatar replacement commits the new reference before deleting the previous object', async () => {
  const events = [];
  const updatedUser = { id: 'user-1', avatar_object_key: 'new-avatar' };
  const { controller, restore } = withMockedUploadController({
    users: {
      replaceUserAvatar: async () => {
        events.push('database-commit');
        return {
          user: updatedUser,
          previousObjectKey: 'old-avatar',
          cleanupJob: { id: 'old-avatar-cleanup' },
        };
      },
    },
    storage: {
      uploadBuffer: async () => { events.push('upload-new'); },
      deleteObject: async (key) => { events.push(`delete:${key}`); },
    },
    cleanupQueue: {
      artifactCleanupQueue: { trigger: () => { events.push('queue-cleanup'); } },
    },
  });

  try {
    const response = createResponse();
    await controller.uploadAvatar(avatarRequest(), response);

    assert.deepEqual(events, [
      'upload-new',
      'database-commit',
      'delete:old-avatar',
      'queue-cleanup',
    ]);
    assert.equal(response.statusCode, undefined);
    assert.deepEqual(response.body, {
      url: '/api/upload/avatar/user-1',
      user: updatedUser,
    });
  } finally {
    restore();
  }
});

test('database failure deletes the newly uploaded avatar and preserves the old reference', async () => {
  const events = [];
  const originalConsoleError = console.error;
  console.error = () => undefined;
  const { controller, restore } = withMockedUploadController({
    users: {
      updateUser: async () => { throw new Error('database failed'); },
      replaceUserAvatar: async () => { throw new Error('database failed'); },
    },
    storage: {
      uploadBuffer: async () => { events.push('upload-new'); },
      deleteObject: async (key) => { events.push(`delete:${key}`); },
    },
  });

  try {
    const response = createResponse();
    await controller.uploadAvatar(avatarRequest(), response);

    assert.deepEqual(events, ['upload-new', 'delete:new-avatar']);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
      error: 'Avatar upload failed',
      details: 'Avatar upload failed',
    });
  } finally {
    console.error = originalConsoleError;
    restore();
  }
});

test('failed old-object deletion remains durable without failing the profile response', async () => {
  const events = [];
  const warnings = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const updatedUser = { id: 'user-1', avatar_object_key: 'new-avatar' };
  const { controller, restore } = withMockedUploadController({
    users: {
      replaceUserAvatar: async () => {
        events.push('database-commit-and-enqueue');
        return {
          user: updatedUser,
          previousObjectKey: 'old-avatar',
          cleanupJob: { id: 'old-avatar-cleanup' },
        };
      },
    },
    storage: {
      uploadBuffer: async () => { events.push('upload-new'); },
      deleteObject: async (key) => {
        events.push(`delete:${key}`);
        throw new Error('storage-secret');
      },
    },
    cleanupQueue: {
      artifactCleanupQueue: { trigger: () => { events.push('queue-cleanup'); } },
    },
  });

  try {
    const response = createResponse();
    await controller.uploadAvatar(avatarRequest(), response);

    assert.deepEqual(events, [
      'upload-new',
      'database-commit-and-enqueue',
      'delete:old-avatar',
      'queue-cleanup',
    ]);
    assert.deepEqual(response.body, {
      url: '/api/upload/avatar/user-1',
      user: updatedUser,
    });
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(warnings), /storage-secret/);
  } finally {
    console.warn = originalConsoleWarn;
    restore();
  }
});

test('failed new-object compensation enqueues durable avatar cleanup', async () => {
  const events = [];
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const warnings = [];
  console.error = () => undefined;
  console.warn = (...args) => warnings.push(args);
  const { controller, restore } = withMockedUploadController({
    users: {
      updateUser: async () => { throw new Error('database failed'); },
      replaceUserAvatar: async () => { throw new Error('database failed'); },
    },
    storage: {
      uploadBuffer: async () => { events.push('upload-new'); },
      deleteObject: async (key) => {
        events.push(`delete:${key}`);
        throw new Error('storage failed');
      },
    },
    cleanupJobs: {
      enqueueAvatarCleanup: async (key) => {
        events.push(`enqueue:${key}`);
        return { id: 'new-avatar-cleanup' };
      },
    },
    cleanupQueue: {
      artifactCleanupQueue: { trigger: () => { events.push('queue-cleanup'); } },
    },
  });

  try {
    const response = createResponse();
    await controller.uploadAvatar(avatarRequest(), response);

    assert.deepEqual(events, [
      'upload-new',
      'delete:new-avatar',
      'enqueue:new-avatar',
      'queue-cleanup',
    ]);
    assert.equal(response.statusCode, 500);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(warnings), /storage failed/);
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    restore();
  }
});

test('avatar replacement repository locks the active user and durably queues the actual previous key', async () => {
  const usersSource = readFileSync(path.join(serverRoot, 'src', 'repositories', 'users.ts'), 'utf8');
  const cleanupSource = readFileSync(
    path.join(serverRoot, 'src', 'repositories', 'cleanupJobs.ts'),
    'utf8',
  );
  assert.match(usersSource, /export const replaceUserAvatar/);
  assert.match(usersSource, /from users[\s\S]*deletion_status = 'active'[\s\S]*for update/i);
  assert.match(usersSource, /enqueueAvatarCleanupWithClient/);
  assert.match(cleanupSource, /export const enqueueAvatarCleanupWithClient/);
  assert.match(cleanupSource, /export const enqueueAvatarCleanup/);

  const { replaceUserAvatar } = require(path.join(serverRoot, 'dist', 'repositories', 'users.js'));
  assert.equal(typeof replaceUserAvatar, 'function');
  const calls = [];
  const newUser = {
    id: 'user-1',
    avatar_object_key: 'new-avatar',
    deletion_status: 'active',
  };
  const result = await replaceUserAvatar('user-1', {
    avatarUrl: '/api/upload/avatar/user-1',
    objectKey: 'new-avatar',
  }, {
    runInTransaction: async (callback) => callback({
      query: async (sql) => {
        calls.push(sql);
        if (/select[\s\S]*from users/i.test(sql)) {
          return { rows: [{ id: 'user-1', avatar_object_key: 'old-avatar' }] };
        }
        if (/update users/i.test(sql)) return { rows: [newUser] };
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    }),
    enqueueCleanupWithClient: async (_client, objectKey) => {
      calls.push(`enqueue:${objectKey}`);
      return { id: 'old-avatar-cleanup' };
    },
  });

  assert.match(calls[0], /for update/i);
  assert.match(calls[1], /update users/i);
  assert.equal(calls[2], 'enqueue:old-avatar');
  assert.deepEqual(result, {
    user: newUser,
    previousObjectKey: 'old-avatar',
    cleanupJob: { id: 'old-avatar-cleanup' },
  });
});

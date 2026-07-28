import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repository = require(path.join(serverRoot, 'dist', 'repositories', 'files.js'));

const baseInput = {
  userId: 'user-1',
  projectSpaceId: 'project-1',
  filename: 'notes.md',
  hash: 'a'.repeat(64),
  size: 60,
  type: 'text/markdown',
};

const limits = {
  maxDocumentBytes: 100,
  maxUserStorageBytes: 100,
  maxUserActiveUploadBytes: 100,
};

const fileRow = (overrides = {}) => ({
  id: 'file-existing',
  user_id: 'user-1',
  project_space_id: 'project-1',
  filename: 'existing.md',
  file_hash: 'f'.repeat(64),
  file_size: 10,
  file_type: 'text/markdown',
  object_key: null,
  status: 'uploading',
  progress: 0,
  error_message: null,
  attempts: 0,
  max_attempts: 3,
  next_attempt_at: null,
  last_attempt_at: null,
  reserved_bytes: 0,
  storage_bytes: 0,
  created_at: '2026-07-12T00:00:00.000Z',
  updated_at: '2026-07-12T00:00:00.000Z',
  ...overrides,
});

const claimKey = (userId, scopeKey, hash, conversionProfile = 'markdown-v1') => (
  `${userId}:${scopeKey}:${hash}:${conversionProfile}`
);

const createFakeUploadDatabase = ({
  files = [],
  claims = [],
  users = [{ id: 'user-1', deletion_status: 'active' }],
  projectSpaces = [{ id: 'project-1', user_id: 'user-1', status: 'active' }],
} = {}) => {
  const state = {
    files: new Map(files.map((file) => [file.id, { ...file }])),
    claims: new Map(claims.map((claim) => [
      claimKey(claim.userId, claim.scopeKey, claim.hash, claim.conversionProfile),
      claim.fileId,
    ])),
    users: new Map(users.map((user) => [user.id, { ...user }])),
    projectSpaces: new Map(projectSpaces.map((space) => [space.id, { ...space }])),
  };
  const calls = [];
  let nextId = 1;
  let transactionTail = Promise.resolve();

  const runInTransaction = async (callback) => {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;

    const client = {
      query: async (sql, params = []) => {
        calls.push({ sql, params: [...params] });
        const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

        if (normalized.startsWith('select id from users') && normalized.includes('for update')) {
          const user = state.users.get(params[0]);
          const requiresActive = normalized.includes("deletion_status = 'active'");
          const available = user && (!requiresActive || user.deletion_status === 'active');
          return { rows: available ? [{ id: user.id }] : [], rowCount: available ? 1 : 0 };
        }

        if (normalized.startsWith('select id from project_spaces') && normalized.includes('for update')) {
          const space = state.projectSpaces.get(params[0]);
          const requiresActive = normalized.includes("status = 'active'");
          const available = space
            && space.user_id === params[1]
            && (!requiresActive || space.status === 'active');
          return { rows: available ? [{ id: space.id }] : [], rowCount: available ? 1 : 0 };
        }

        if (normalized.includes('from file_content_claims') && normalized.includes('join files')) {
          const id = state.claims.get(claimKey(params[0], params[1], params[2], params[3]));
          return { rows: id && state.files.has(id) ? [{ ...state.files.get(id) }] : [], rowCount: id ? 1 : 0 };
        }

        if (normalized.includes('sum(storage_bytes)') && normalized.includes('sum(reserved_bytes)')) {
          const userFiles = [...state.files.values()].filter((file) => file.user_id === params[0]);
          const storageBytes = userFiles.reduce((sum, file) => sum + Number(file.storage_bytes || 0), 0);
          const reservedBytes = userFiles.reduce((sum, file) => sum + Number(file.reserved_bytes || 0), 0);
          return {
            rows: [{ storage_bytes: String(storageBytes), reserved_bytes: String(reservedBytes) }],
            rowCount: 1,
          };
        }

        if (normalized.startsWith('insert into files')) {
          const id = `file-${nextId++}`;
          const created = fileRow({
            id,
            user_id: params[0],
            project_space_id: params[1],
            filename: params[2],
            file_hash: params[3],
            file_size: params[4],
            file_type: params[5],
            declared_mime_type: params[6],
            document_kind: params[7],
            max_attempts: params[8],
            reserved_bytes: params[9],
          });
          state.files.set(id, created);
          return { rows: [{ ...created }], rowCount: 1 };
        }

        if (normalized.startsWith('insert into file_content_claims')) {
          const key = claimKey(params[0], params[1], params[2], params[3]);
          if (state.claims.has(key)) return { rows: [], rowCount: 0 };
          state.claims.set(key, params[4]);
          return { rows: [{ file_id: params[4] }], rowCount: 1 };
        }

        if (normalized.startsWith('update files') && normalized.includes("status = 'uploading'")) {
          const existing = state.files.get(params[0]);
          if (!existing) return { rows: [], rowCount: 0 };
          const resumed = {
            ...existing,
            status: 'uploading',
            filename: params[1],
            file_size: params[2],
            file_type: params[3],
            declared_mime_type: params[4],
            document_kind: params[5],
            reserved_bytes: params[6],
            error_message: null,
          };
          state.files.set(existing.id, resumed);
          return { rows: [{ ...resumed }], rowCount: 1 };
        }

        if (normalized.startsWith('delete from files')) {
          state.files.delete(params[0]);
          return { rows: [], rowCount: 1 };
        }

        throw new Error(`Unexpected SQL in fake upload database: ${sql}`);
      },
    };

    try {
      return await callback(client);
    } finally {
      release();
    }
  };

  return { calls, runInTransaction, state };
};

const reserve = (input, database, quotaLimits = limits) => {
  assert.equal(
    typeof repository.reserveUploadFile,
    'function',
    'files repository must expose reserveUploadFile',
  );
  return repository.reserveUploadFile(input, {
    limits: quotaLimits,
    runInTransaction: database.runInTransaction,
  });
};

test('file lifecycle migration adds non-negative accounting and canonical claims without deleting legacy duplicates', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0026_file_lifecycle_cleanup.sql');
  assert.equal(existsSync(migrationPath), true, '0026 file lifecycle migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /add column if not exists reserved_bytes bigint/i);
  assert.match(sql, /add column if not exists storage_bytes bigint/i);
  assert.match(sql, /reserved_bytes[^;]*check[^;]*>= 0/is);
  assert.match(sql, /storage_bytes[^;]*check[^;]*>= 0/is);
  assert.match(sql, /status in \([^)]*'deleting'/is);
  assert.match(sql, /create table if not exists file_content_claims/i);
  assert.match(sql, /primary key \(user_id, scope_key, file_hash\)/i);
  assert.match(sql, /file_id uuid not null references files\(id\) on delete cascade/i);
  assert.match(
    sql,
    /constraint file_content_claims_hash_check[^;]*file_hash ~ '\^\[0-9a-f\]\{64\}\$'/is,
  );
  assert.match(sql, /create unique index[^;]*file_content_claims[^;]*\(file_id\)/i);
  assert.match(sql, /coalesce\(project_space_id::text, '__global__'\)/i);
  assert.match(sql, /insert into file_content_claims[\s\S]*on conflict do nothing/i);
  assert.doesNotMatch(sql, /delete from files/i);
});

test('concurrent identical reservations return one canonical file and consume quota once', async () => {
  const database = createFakeUploadDatabase();

  const results = await Promise.all([
    reserve(baseInput, database),
    reserve(baseInput, database),
  ]);

  assert.equal(results[0].file.id, results[1].file.id);
  assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
  assert.equal(database.state.files.size, 1);
  assert.equal(database.state.claims.size, 1);
  assert.equal([...database.state.files.values()][0].reserved_bytes, 60);
  assert.match(database.calls[0].sql, /select id\s+from users[\s\S]*for update/i);
});

test('identical bytes with different conversion profiles keep distinct canonical documents', async () => {
  const database = createFakeUploadDatabase();
  const expandedLimits = {
    maxDocumentBytes: 100,
    maxUserStorageBytes: 200,
    maxUserActiveUploadBytes: 200,
  };

  const markdown = await reserve(baseInput, database, expandedLimits);
  const plaintext = await reserve({
    ...baseInput,
    filename: 'notes.txt',
    type: 'text/plain',
    documentKind: 'plaintext',
    conversionProfile: 'plaintext-v1',
  }, database, expandedLimits);

  assert.notEqual(markdown.file.id, plaintext.file.id);
  assert.equal(database.state.files.size, 2);
  assert.equal(database.state.claims.size, 2);
});

test('the per-user lock serializes different hashes so active reservations cannot oversubscribe', async () => {
  const database = createFakeUploadDatabase();
  const outcomes = await Promise.allSettled([
    reserve(baseInput, database),
    reserve({ ...baseInput, filename: 'other.md', hash: 'b'.repeat(64) }, database),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.equal(rejected.reason.code, 'ACTIVE_UPLOAD_QUOTA_EXCEEDED');
  assert.equal(database.state.files.size, 1);
  assert.equal(database.state.claims.size, 1);
});

test('stored bytes plus reservations are both included in the total user storage budget', async () => {
  const database = createFakeUploadDatabase({
    files: [
      fileRow({ id: 'stored', status: 'completed', object_key: 'stored.md', storage_bytes: 50 }),
      fileRow({ id: 'reserved', file_hash: 'e'.repeat(64), reserved_bytes: 30 }),
    ],
  });

  await assert.rejects(
    reserve({ ...baseInput, size: 21 }, database, {
      maxDocumentBytes: 100,
      maxUserStorageBytes: 100,
      maxUserActiveUploadBytes: 100,
    }),
    (error) => error.code === 'USER_STORAGE_QUOTA_EXCEEDED',
  );
  assert.equal(database.state.files.size, 2);
});

test('repository rejects an oversized document before opening a transaction', async () => {
  const database = createFakeUploadDatabase();

  await assert.rejects(
    reserve({ ...baseInput, size: 101 }, database),
    (error) => error.code === 'DOCUMENT_TOO_LARGE',
  );
  assert.equal(database.calls.length, 0);
});

test('reservation rejects an account that became deletion-pending before the user lock', async () => {
  const database = createFakeUploadDatabase({
    users: [{ id: 'user-1', deletion_status: 'pending' }],
  });

  await assert.rejects(
    reserve(baseInput, database),
    (error) => error.code === 'UPLOAD_USER_NOT_FOUND',
  );
  assert.equal(database.calls.length, 1);
  assert.match(database.calls[0].sql, /deletion_status = 'active'[\s\S]*for update/i);
  assert.equal(database.state.files.size, 0);
});

test('reservation locks the user first and rejects a deleting project space', async () => {
  const database = createFakeUploadDatabase({
    projectSpaces: [{ id: 'project-1', user_id: 'user-1', status: 'deleting' }],
  });

  await assert.rejects(
    reserve(baseInput, database),
    (error) => error.code === 'UPLOAD_PROJECT_NOT_FOUND',
  );
  assert.equal(database.calls.length, 2);
  assert.match(database.calls[0].sql, /from users[\s\S]*for update/i);
  assert.match(database.calls[1].sql, /from project_spaces[\s\S]*status = 'active'[\s\S]*for update/i);
  assert.equal(database.state.files.size, 0);
});

test('a failed upload with no external object reacquires quota on the same canonical file', async () => {
  const failed = fileRow({
    id: 'failed-canonical',
    file_hash: baseInput.hash,
    status: 'failed',
    reserved_bytes: 0,
    storage_bytes: 0,
    object_key: null,
  });
  const database = createFakeUploadDatabase({
    files: [failed],
    claims: [{
      userId: failed.user_id,
      scopeKey: failed.project_space_id,
      hash: failed.file_hash,
      fileId: failed.id,
    }],
  });

  const result = await reserve(baseInput, database);

  assert.equal(result.created, false);
  assert.equal(result.file.id, failed.id);
  assert.equal(result.file.status, 'uploading');
  assert.equal(result.file.reserved_bytes, baseInput.size);
  assert.equal(database.state.files.size, 1);
});

test('legacy upload initialization stops when the atomic reservation finds completed content', () => {
  const source = readFileSync(path.resolve(serverRoot, '..', 'client', 'src', 'lib', 'uploadManager.ts'), 'utf8');
  const legacyBody = source.split('const uploadWithLegacyChunks', 2)[1].split('export const uploadFile', 1)[0];

  assert.match(legacyBody, /initData\.(?:exists|uploadNeeded)/);
  assert.match(legacyBody, /status: 'completed'/);
  assert.match(legacyBody, /return;/);
});

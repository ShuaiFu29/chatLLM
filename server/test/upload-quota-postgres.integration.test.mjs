import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const integrationEnabled = process.env.UPLOAD_QUOTA_INTEGRATION === '1'
  && Boolean(process.env.TEST_DATABASE_URL);

test('PostgreSQL serializes upload quota reservations and canonical claims across connections', {
  skip: integrationEnabled ? false : 'set UPLOAD_QUOTA_INTEGRATION=1 and TEST_DATABASE_URL to run',
}, async () => {
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  const { randomUUID } = await import('node:crypto');
  const { pool, closeDatabasePool } = require(path.join(serverRoot, 'dist', 'lib', 'db.js'));
  const { runMigrations } = require(path.join(serverRoot, 'dist', 'lib', 'migrations.js'));
  const { reserveUploadFile } = require(path.join(serverRoot, 'dist', 'repositories', 'files.js'));
  const userId = randomUUID();
  const projectSpaceId = randomUUID();
  const limits = {
    maxDocumentBytes: 1000,
    maxUserStorageBytes: 1000,
    maxUserActiveUploadBytes: 100,
  };

  try {
    await runMigrations();

    const lifecycleSql = readFileSync(
      path.join(serverRoot, 'migrations', '0026_file_lifecycle_cleanup.sql'),
      'utf8',
    );
    const migrationClient = await pool.connect();
    try {
      await migrationClient.query('begin');
      await migrationClient.query(lifecycleSql);
      await migrationClient.query('rollback');
    } finally {
      migrationClient.release();
    }

    await pool.query(
      `insert into users (id, github_id, username, avatar_url, display_name)
       values ($1, $2, $3, '', $3)`,
      [userId, String(Date.now()), `quota-${userId}`],
    );
    await pool.query(
      `insert into project_spaces (id, user_id, name, is_default)
       values ($1, $2, 'Quota integration', true)`,
      [projectSpaceId, userId],
    );

    const input = {
      userId,
      projectSpaceId,
      filename: 'same.md',
      hash: 'a'.repeat(64),
      size: 60,
      type: 'text/markdown',
    };
    const identical = await Promise.all([
      reserveUploadFile(input, { limits }),
      reserveUploadFile(input, { limits }),
    ]);

    assert.equal(identical[0].file.id, identical[1].file.id);
    assert.deepEqual(identical.map((result) => result.created).sort(), [false, true]);
    const identicalCounts = await pool.query(
      `select
         (select count(*)::integer from files where user_id = $1) as files,
         (select count(*)::integer from file_content_claims where user_id = $1) as claims,
         (select coalesce(sum(reserved_bytes), 0)::integer from files where user_id = $1) as reserved`,
      [userId],
    );
    assert.deepEqual(identicalCounts.rows[0], { files: 1, claims: 1, reserved: 60 });

    await pool.query('delete from files where user_id = $1', [userId]);
    const different = await Promise.allSettled([
      reserveUploadFile({ ...input, hash: 'b'.repeat(64), filename: 'one.md' }, { limits }),
      reserveUploadFile({ ...input, hash: 'c'.repeat(64), filename: 'two.md' }, { limits }),
    ]);

    assert.equal(different.filter((result) => result.status === 'fulfilled').length, 1);
    const rejection = different.find((result) => result.status === 'rejected');
    assert.equal(rejection.reason.code, 'ACTIVE_UPLOAD_QUOTA_EXCEEDED');
    const quotaCounts = await pool.query(
      `select count(*)::integer as files, coalesce(sum(reserved_bytes), 0)::integer as reserved
       from files
       where user_id = $1`,
      [userId],
    );
    assert.deepEqual(quotaCounts.rows[0], { files: 1, reserved: 60 });
  } finally {
    await pool.query('delete from users where id = $1', [userId]).catch(() => undefined);
    await closeDatabasePool();
  }
});

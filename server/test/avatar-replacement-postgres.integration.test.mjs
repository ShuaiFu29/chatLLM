import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquirePostgresIntegrationLock } from './postgres-integration-lock.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const integrationEnabled = process.env.AVATAR_REPLACEMENT_INTEGRATION === '1'
  && Boolean(process.env.TEST_DATABASE_URL);

test('PostgreSQL serializes concurrent avatar replacement and queues every superseded object', {
  skip: integrationEnabled ? false : 'set AVATAR_REPLACEMENT_INTEGRATION=1 and TEST_DATABASE_URL to run',
}, async () => {
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  const { randomUUID } = await import('node:crypto');
  const { pool, closeDatabasePool } = require(path.join(serverRoot, 'dist', 'lib', 'db.js'));
  const { runMigrations } = require(path.join(serverRoot, 'dist', 'lib', 'migrations.js'));
  const { replaceUserAvatar } = require(path.join(serverRoot, 'dist', 'repositories', 'users.js'));
  const userId = randomUUID();
  const username = `avatar-${userId}`;
  const oldKey = `users/${userId}/avatars/old.png`;
  const newKeys = [
    `users/${userId}/avatars/new-a.png`,
    `users/${userId}/avatars/new-b.png`,
  ];
  let releaseIntegrationLock = async () => undefined;

  try {
    releaseIntegrationLock = await acquirePostgresIntegrationLock(pool);
    await runMigrations();
    await pool.query(
      `insert into users (
         id,
         github_id,
         username,
         avatar_url,
         avatar_object_key,
         display_name
       )
       values ($1, $2, $3, '/old', $4, $3)`,
      [userId, String(BigInt(Date.now()) * 1000n + 91n), username, oldKey],
    );

    const replacements = await Promise.all(newKeys.map((objectKey) => replaceUserAvatar(userId, {
      avatarUrl: `/api/upload/avatar/${userId}`,
      objectKey,
    })));
    assert.equal(replacements.every(Boolean), true);

    const finalUser = await pool.query(
      'select avatar_object_key from users where id = $1',
      [userId],
    );
    const finalKey = finalUser.rows[0].avatar_object_key;
    assert.equal(newKeys.includes(finalKey), true);
    const intermediateKey = newKeys.find((key) => key !== finalKey);

    const previousKeys = replacements.map((replacement) => replacement.previousObjectKey).sort();
    assert.deepEqual(previousKeys, [intermediateKey, oldKey].sort());

    const jobs = await pool.query(
      `select status, payload->>'object_key' as object_key
       from artifact_cleanup_jobs
       where resource_type = 'avatar'
         and payload->>'object_key' = any($1::text[])
       order by object_key`,
      [[oldKey, intermediateKey]],
    );
    assert.deepEqual(jobs.rows, [
      { status: 'queued', object_key: intermediateKey },
      { status: 'queued', object_key: oldKey },
    ].sort((left, right) => left.object_key.localeCompare(right.object_key)));
    assert.equal(jobs.rows.some((job) => job.object_key === finalKey), false);
  } finally {
    await pool.query(
      `delete from artifact_cleanup_jobs
       where resource_type = 'avatar'
         and payload->>'object_key' = any($1::text[])`,
      [[oldKey, ...newKeys]],
    ).catch(() => undefined);
    await pool.query('delete from users where id = $1', [userId]).catch(() => undefined);
    try {
      await releaseIntegrationLock();
    } finally {
      await closeDatabasePool();
    }
  }
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquirePostgresIntegrationLock } from './postgres-integration-lock.mjs';

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
  const {
    claimMultipartUploadAbort,
    claimMultipartUploadCompletion,
    createMultipartUploadSession,
    finalizeMultipartUploadAbort,
    finalizeMultipartUploadCompletion,
    finalizeMultipartUploadFailure,
    markMultipartUploadCompletionRetryable,
    reclaimMultipartUploadCompletion,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'uploadMultipart.js'));
  const userId = randomUUID();
  const projectSpaceId = randomUUID();
  const limits = {
    maxDocumentBytes: 1000,
    maxUserStorageBytes: 1000,
    maxUserActiveUploadBytes: 100,
  };
  let releaseIntegrationLock = async () => undefined;

  try {
    releaseIntegrationLock = await acquirePostgresIntegrationLock(pool);
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

    await pool.query('delete from files where user_id = $1', [userId]);
    const multipartReservation = await reserveUploadFile({
      ...input,
      filename: 'multipart.md',
      hash: 'd'.repeat(64),
      size: 12,
    }, { limits });
    const multipartFileId = multipartReservation.file.id;
    const multipartObjectKey = `users/${userId}/files/${multipartFileId}/multipart.md`;
    const multipartInput = {
      fileId: multipartFileId,
      userId,
      projectSpaceId,
      objectKey: multipartObjectKey,
      partSize: 5 * 1024 * 1024,
      totalParts: 1,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const sessionCreations = await Promise.all([
      createMultipartUploadSession({ ...multipartInput, storageUploadId: 'storage-upload-a' }),
      createMultipartUploadSession({ ...multipartInput, storageUploadId: 'storage-upload-b' }),
    ]);

    assert.deepEqual(sessionCreations.map((result) => result.created).sort(), [false, true]);
    assert.equal(
      sessionCreations[0].session.storage_upload_id,
      sessionCreations[1].session.storage_upload_id,
    );
    const sessionCount = await pool.query(
      'select count(*)::integer as count from upload_multipart_sessions where file_id = $1',
      [multipartFileId],
    );
    assert.equal(sessionCount.rows[0].count, 1);

    const completionClaims = await Promise.all([
      claimMultipartUploadCompletion(multipartFileId, userId),
      claimMultipartUploadCompletion(multipartFileId, userId),
    ]);
    assert.equal(completionClaims.filter(Boolean).length, 1);

    await assert.rejects(
      finalizeMultipartUploadCompletion(multipartFileId, userId, 'wrong-object-key', 11),
      /multipart completion evidence/i,
    );
    const stateAfterInvalidEvidence = await pool.query(
      `select f.status as file_status, ums.status as session_status
       from files f
       join upload_multipart_sessions ums on ums.file_id = f.id
       where f.id = $1`,
      [multipartFileId],
    );
    assert.deepEqual(stateAfterInvalidEvidence.rows[0], {
      file_status: 'uploading',
      session_status: 'completing',
    });

    const completion = await finalizeMultipartUploadCompletion(
      multipartFileId,
      userId,
      multipartObjectKey,
      12,
    );
    assert.equal(completion.transitioned, true);
    const completedState = await pool.query(
      `select
         f.status as file_status,
         f.object_key,
         f.reserved_bytes::integer,
         f.storage_bytes::integer,
         ums.status as session_status
       from files f
       join upload_multipart_sessions ums on ums.file_id = f.id
       where f.id = $1`,
      [multipartFileId],
    );
    assert.deepEqual(completedState.rows[0], {
      file_status: 'pending',
      object_key: multipartObjectKey,
      reserved_bytes: 0,
      storage_bytes: 12,
      session_status: 'completed',
    });
    assert.equal(await claimMultipartUploadAbort(multipartFileId, userId), null);
    const lateAbort = await finalizeMultipartUploadAbort(
      multipartFileId,
      userId,
      'late abort must be ignored',
    );
    assert.equal(lateAbort.transitioned, false);

    const missingReservation = await reserveUploadFile({
      ...input,
      filename: 'missing.md',
      hash: 'e'.repeat(64),
      size: 13,
    }, { limits });
    const missingFileId = missingReservation.file.id;
    const missingObjectKey = `users/${userId}/files/${missingFileId}/missing.md`;
    await createMultipartUploadSession({
      ...multipartInput,
      fileId: missingFileId,
      objectKey: missingObjectKey,
      storageUploadId: 'storage-upload-missing',
    });
    assert.ok(await claimMultipartUploadCompletion(missingFileId, userId));
    const missingFinalization = await finalizeMultipartUploadFailure(
      missingFileId,
      userId,
      'Multipart upload no longer exists',
    );
    assert.equal(missingFinalization.transitioned, true);
    const missingState = await pool.query(
      `select
         f.status as file_status,
         f.reserved_bytes::integer,
         f.storage_bytes::integer,
         ums.status as session_status
       from files f
       join upload_multipart_sessions ums on ums.file_id = f.id
       where f.id = $1`,
      [missingFileId],
    );
    assert.deepEqual(missingState.rows[0], {
      file_status: 'failed',
      reserved_bytes: 0,
      storage_bytes: 0,
      session_status: 'failed',
    });

    const raceReservation = await reserveUploadFile({
      ...input,
      filename: 'race.md',
      hash: 'f'.repeat(64),
      size: 14,
    }, { limits });
    const raceFileId = raceReservation.file.id;
    const raceObjectKey = `users/${userId}/files/${raceFileId}/race.md`;
    await createMultipartUploadSession({
      ...multipartInput,
      fileId: raceFileId,
      objectKey: raceObjectKey,
      storageUploadId: 'storage-upload-race',
    });
    const ownershipRace = await Promise.all([
      claimMultipartUploadCompletion(raceFileId, userId),
      claimMultipartUploadAbort(raceFileId, userId),
    ]);
    assert.equal(ownershipRace.filter(Boolean).length, 1);

    const retryReservation = await reserveUploadFile({
      ...input,
      filename: 'retry.md',
      hash: '0'.repeat(64),
      size: 15,
    }, { limits });
    const retryFileId = retryReservation.file.id;
    await createMultipartUploadSession({
      ...multipartInput,
      fileId: retryFileId,
      objectKey: `users/${userId}/files/${retryFileId}/retry.md`,
      storageUploadId: 'storage-upload-retry',
    });
    assert.ok(await claimMultipartUploadCompletion(retryFileId, userId));
    const retryMarker = 'Multipart completion is pending reconciliation';
    assert.ok(await markMultipartUploadCompletionRetryable(retryFileId, userId, retryMarker));
    const reclaimRace = await Promise.all([
      reclaimMultipartUploadCompletion(retryFileId, userId, retryMarker),
      reclaimMultipartUploadCompletion(retryFileId, userId, retryMarker),
    ]);
    assert.equal(reclaimRace.filter(Boolean).length, 1);
  } finally {
    await pool.query('delete from users where id = $1', [userId]).catch(() => undefined);
    try {
      await releaseIntegrationLock();
    } finally {
      await closeDatabasePool();
    }
  }
});

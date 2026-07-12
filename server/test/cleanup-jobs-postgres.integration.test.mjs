import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquirePostgresIntegrationLock } from './postgres-integration-lock.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const integrationEnabled = process.env.CLEANUP_JOBS_INTEGRATION === '1'
  && Boolean(process.env.TEST_DATABASE_URL);

test('PostgreSQL cleanup jobs fence workers, resume steps, and serialize deletion races', {
  skip: integrationEnabled ? false : 'set CLEANUP_JOBS_INTEGRATION=1 and TEST_DATABASE_URL to run',
}, async () => {
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  const { randomUUID } = await import('node:crypto');
  const { pool, closeDatabasePool } = require(path.join(serverRoot, 'dist', 'lib', 'db.js'));
  const { runMigrations } = require(path.join(serverRoot, 'dist', 'lib', 'migrations.js'));
  const cleanup = require(path.join(serverRoot, 'dist', 'repositories', 'cleanupJobs.js'));
  const { reserveUploadFile, updateFile } = require(
    path.join(serverRoot, 'dist', 'repositories', 'files.js'),
  );
  const { createMultipartUploadSession } = require(
    path.join(serverRoot, 'dist', 'repositories', 'uploadMultipart.js'),
  );
  const { executeArtifactCleanupJob } = require(
    path.join(serverRoot, 'dist', 'services', 'cleanupQueue.js'),
  );

  const userId = randomUUID();
  const defaultProjectId = randomUUID();
  const projectId = randomUUID();
  const accountUserId = randomUUID();
  const cleanupResourceIds = [];
  const limits = {
    maxDocumentBytes: 10_000,
    maxUserStorageBytes: 100_000,
    maxUserActiveUploadBytes: 100_000,
  };
  let githubId = BigInt(Date.now()) * 1000n;
  let releaseIntegrationLock = async () => undefined;

  const insertUser = async (id, username) => {
    githubId += 1n;
    await pool.query(
      `insert into users (id, github_id, username, avatar_url, display_name)
       values ($1, $2, $3, '', $3)`,
      [id, githubId.toString(), username],
    );
  };

  const claimRow = async (jobId, resourceId) => {
    const leaseToken = randomUUID();
    const { rows } = await pool.query(
      `update artifact_cleanup_jobs
       set status = 'processing',
           attempts = attempts + 1,
           worker_id = 'integration-worker',
           lease_token = $2,
           lease_expires_at = now() + interval '5 minutes',
           next_attempt_at = null,
           updated_at = now()
       where id = $1
       returning *`,
      [jobId, leaseToken],
    );
    return { ...rows[0], resource_id: resourceId, lease_token: leaseToken };
  };

  const executeFileCleanup = (job, seen = []) => executeArtifactCleanupJob(job, {
    cleanupRagFile: async () => { seen.push(`rag:${job.resource_id}`); },
    abortMultipartUpload: async () => { seen.push(`multipart:${job.resource_id}`); },
    deleteStorageObject: async (key) => { seen.push(`storage:${key}`); },
    warn: () => undefined,
  });

  try {
    releaseIntegrationLock = await acquirePostgresIntegrationLock(pool);
    await runMigrations();
    await insertUser(userId, `cleanup-${userId}`);
    await pool.query(
      `insert into project_spaces (id, user_id, name, is_default)
       values ($1, $2, 'Cleanup default', true)`,
      [defaultProjectId, userId],
    );

    const firstReservation = await reserveUploadFile({
      userId,
      projectSpaceId: defaultProjectId,
      filename: 'leased.md',
      hash: '1'.repeat(64),
      size: 50,
      type: 'text/markdown',
    }, { limits });
    const firstFileId = firstReservation.file.id;
    cleanupResourceIds.push(firstFileId);
    await pool.query(
      `insert into file_ingestion_jobs (
         file_id,
         user_id,
         project_space_id,
         status,
         stage,
         attempt_id,
         lease_token,
         lease_expires_at
       )
       values ($1, $2, $3, 'processing', 'embedding', $4, $5, now() + interval '5 minutes')`,
      [firstFileId, userId, defaultProjectId, randomUUID(), randomUUID()],
    );

    const enqueued = await cleanup.enqueueFileCleanup(firstFileId, userId);
    assert.ok(enqueued);
    const deletionState = await pool.query(
      `select
         f.status as file_status,
         j.status as ingestion_status,
         j.lease_expires_at <= now() as ingestion_lease_invalidated,
         c.status as cleanup_status
       from files f
       join file_ingestion_jobs j on j.file_id = f.id
       join artifact_cleanup_jobs c on c.resource_key = 'file:' || f.id::text
       where f.id = $1`,
      [firstFileId],
    );
    assert.deepEqual(deletionState.rows[0], {
      file_status: 'deleting',
      ingestion_status: 'cancelled',
      ingestion_lease_invalidated: true,
      cleanup_status: 'queued',
    });
    await assert.rejects(
      createMultipartUploadSession({
        fileId: firstFileId,
        userId,
        projectSpaceId: defaultProjectId,
        objectKey: `users/${userId}/files/${firstFileId}/late-multipart.md`,
        storageUploadId: 'late-multipart-upload',
        partSize: 5 * 1024 * 1024,
        totalParts: 1,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      (error) => error?.code === 'MULTIPART_UPLOAD_UNAVAILABLE',
    );
    assert.equal((await pool.query(
      'select 1 from upload_multipart_sessions where file_id = $1',
      [firstFileId],
    )).rowCount, 0);

    const concurrentClaims = await Promise.all([
      cleanup.claimNextCleanupJob('cleanup-worker-a', { leaseDurationMs: 60_000 }),
      cleanup.claimNextCleanupJob('cleanup-worker-b', { leaseDurationMs: 60_000 }),
    ]);
    assert.equal(concurrentClaims.filter(Boolean).length, 1);
    const firstClaim = concurrentClaims.find(Boolean);
    assert.equal(firstClaim.resource_id, firstFileId);
    await assert.rejects(
      cleanup.updateCleanupJobStep({ id: firstClaim.id, lease_token: randomUUID() }, 'forbidden'),
      (error) => error?.name === 'CleanupLeaseLostError',
    );
    assert.ok(await cleanup.renewCleanupJobLease(firstClaim, { leaseDurationMs: 60_000 }));
    assert.deepEqual(await executeFileCleanup(firstClaim), { state: 'completed' });

    const completed = await pool.query(
      `select status, step_state
       from artifact_cleanup_jobs
       where id = $1`,
      [firstClaim.id],
    );
    assert.equal(completed.rows[0].status, 'completed');
    assert.equal(completed.rows[0].step_state.finalized, true);
    assert.equal((await pool.query('select 1 from files where id = $1', [firstFileId])).rowCount, 0);

    const lateObjectKey = `users/${userId}/files/${firstFileId}/late.md`;
    assert.equal(await updateFile(firstFileId, {
      status: 'failed',
      object_key: lateObjectKey,
      reserved_bytes: 0,
      storage_bytes: 50,
    }), null);
    const reopened = await pool.query(
      `select status, step_state, payload, lease_token, completed_at
       from artifact_cleanup_jobs
       where id = $1`,
      [firstClaim.id],
    );
    assert.equal(reopened.rows[0].status, 'queued');
    assert.equal(reopened.rows[0].step_state.rag_deleted, true);
    assert.equal(reopened.rows[0].step_state.multipart_aborted, true);
    assert.equal(reopened.rows[0].step_state.storage_deleted, undefined);
    assert.equal(reopened.rows[0].step_state.finalized, undefined);
    assert.equal(reopened.rows[0].payload.object_key, lateObjectKey);
    assert.equal(reopened.rows[0].lease_token, null);
    assert.equal(reopened.rows[0].completed_at, null);

    const lateClaim = await cleanup.claimNextCleanupJob('cleanup-worker-late');
    const lateCalls = [];
    assert.deepEqual(await executeArtifactCleanupJob(lateClaim, {
      cleanupRagFile: async () => { throw new Error('completed RAG step must not repeat'); },
      abortMultipartUpload: async () => { throw new Error('completed multipart step must not repeat'); },
      deleteStorageObject: async (key) => { lateCalls.push(key); },
      warn: () => undefined,
    }), { state: 'completed' });
    assert.deepEqual(lateCalls, [lateObjectKey]);

    const exhaustedId = randomUUID();
    cleanupResourceIds.push(exhaustedId);
    await pool.query(
      `insert into artifact_cleanup_jobs (
         id,
         resource_key,
         resource_type,
         resource_id,
         status,
         attempts,
         max_attempts,
         worker_id,
         lease_token,
         lease_expires_at
       )
       values ($1::uuid, 'avatar:' || $1::text, 'avatar', $1::text, 'processing', 2, 2,
               'stale-worker', $2, now() - interval '1 minute')`,
      [exhaustedId, randomUUID()],
    );
    assert.equal(await cleanup.failExhaustedCleanupJobs({ limit: 10 }), 1);
    const exhausted = await pool.query(
      `select status, next_attempt_at, lease_token, last_error
       from artifact_cleanup_jobs
       where id = $1`,
      [exhaustedId],
    );
    assert.deepEqual(exhausted.rows[0], {
      status: 'failed',
      next_attempt_at: null,
      lease_token: null,
      last_error: 'Artifact cleanup lease expired after maximum attempts',
    });

    await pool.query(
      `insert into project_spaces (id, user_id, name, is_default)
       values ($1, $2, 'Cleanup children', false)`,
      [projectId, userId],
    );
    const childFiles = [];
    for (const [index, hash] of ['2', '3'].entries()) {
      const reservation = await reserveUploadFile({
        userId,
        projectSpaceId: projectId,
        filename: `child-${index}.md`,
        hash: hash.repeat(64),
        size: 20,
        type: 'text/markdown',
      }, { limits });
      childFiles.push(reservation.file.id);
      cleanupResourceIds.push(reservation.file.id);
    }
    const projectCleanup = await cleanup.enqueueProjectSpaceCleanup(projectId, userId);
    cleanupResourceIds.push(projectId);
    assert.equal(projectCleanup.childCount, 2);
    await assert.rejects(
      reserveUploadFile({
        userId,
        projectSpaceId: projectId,
        filename: 'too-late.md',
        hash: '4'.repeat(64),
        size: 20,
        type: 'text/markdown',
      }, { limits }),
      (error) => error?.code === 'UPLOAD_PROJECT_NOT_FOUND',
    );
    const parentClaim = await claimRow(projectCleanup.job.id, projectId);
    await assert.rejects(
      cleanup.finalizeProjectSpaceCleanup(parentClaim),
      /child jobs are incomplete/i,
    );
    assert.deepEqual(await cleanup.getCleanupChildSummary(projectCleanup.job.id), {
      pending: 2,
      failed: 0,
    });

    const childRows = await pool.query(
      `select *
       from artifact_cleanup_jobs
       where parent_job_id = $1
       order by resource_id`,
      [projectCleanup.job.id],
    );
    for (const child of childRows.rows) {
      const childClaim = await claimRow(child.id, child.resource_id);
      assert.deepEqual(await executeFileCleanup(childClaim), { state: 'completed' });
    }
    assert.deepEqual(await cleanup.getCleanupChildSummary(projectCleanup.job.id), {
      pending: 0,
      failed: 0,
    });
    assert.ok(await cleanup.finalizeProjectSpaceCleanup(parentClaim));
    assert.equal((await pool.query('select 1 from project_spaces where id = $1', [projectId])).rowCount, 0);
    assert.equal((await pool.query('select 1 from files where id = any($1::uuid[])', [childFiles])).rowCount, 0);

    await insertUser(accountUserId, `account-cleanup-${accountUserId}`);
    await pool.query(
      `insert into sessions (token_hash, user_id, expires_at)
       values ($1, $2, now() + interval '1 day')`,
      ['a'.repeat(64), accountUserId],
    );
    const accountCleanup = await cleanup.enqueueAccountCleanup(accountUserId);
    cleanupResourceIds.push(accountUserId);
    const accountState = await pool.query(
      `select
         u.deletion_status,
         (select count(*)::integer from sessions where user_id = u.id) as sessions
       from users u
       where u.id = $1`,
      [accountUserId],
    );
    assert.deepEqual(accountState.rows[0], { deletion_status: 'pending', sessions: 0 });
    await assert.rejects(
      reserveUploadFile({
        userId: accountUserId,
        filename: 'too-late.md',
        hash: '5'.repeat(64),
        size: 20,
        type: 'text/markdown',
      }, { limits }),
      (error) => error?.code === 'UPLOAD_USER_NOT_FOUND',
    );
    const accountClaim = await claimRow(accountCleanup.job.id, accountUserId);
    assert.ok(await cleanup.finalizeAccountCleanup(accountClaim));
    assert.equal((await pool.query('select 1 from users where id = $1', [accountUserId])).rowCount, 0);
  } finally {
    await pool.query(
      'delete from artifact_cleanup_jobs where resource_id = any($1::text[])',
      [cleanupResourceIds],
    ).catch(() => undefined);
    await pool.query('delete from users where id = any($1::uuid[])', [
      [userId, accountUserId],
    ]).catch(() => undefined);
    try {
      await releaseIntegrationLock();
    } finally {
      await closeDatabasePool();
    }
  }
});

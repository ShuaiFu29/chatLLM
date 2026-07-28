import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');
const readOptionalSource = (relativePath) => {
  const absolutePath = path.join(serverRoot, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
};

test('file lifecycle migration defines durable leased cleanup jobs and deletion markers', () => {
  const migration = readSource('migrations/0026_file_lifecycle_cleanup.sql');

  assert.match(migration, /alter table users[\s\S]*deletion_status text/i);
  assert.match(migration, /alter table project_spaces[\s\S]*status text/i);
  assert.match(migration, /create table if not exists artifact_cleanup_jobs/i);
  assert.match(migration, /resource_key text not null unique/i);
  assert.match(migration, /parent_job_id uuid/i);
  assert.match(migration, /step_state jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /attempts integer not null default 0/i);
  assert.match(migration, /next_attempt_at timestamptz/i);
  assert.match(migration, /lease_token uuid/i);
  assert.match(migration, /lease_expires_at timestamptz/i);
  assert.match(migration, /artifact_cleanup_jobs_ready_idx/i);
  assert.match(migration, /artifact_cleanup_jobs_lease_idx/i);
});

test('deletion requests mark resources, invalidate ingestion, and enqueue in one transaction', () => {
  const repository = readOptionalSource('src/repositories/cleanupJobs.ts');
  const fileEnqueue = repository.split('export const enqueueFileCleanup', 2)[1]
    ?.split('export const enqueueProjectSpaceCleanup', 1)[0] || '';
  const projectEnqueue = repository.split('export const enqueueProjectSpaceCleanup', 2)[1]
    ?.split('export const enqueueAccountCleanup', 1)[0] || '';

  assert.match(repository, /export const enqueueFileCleanup/);
  assert.match(repository, /export const enqueueProjectSpaceCleanup/);
  assert.match(repository, /export const enqueueAccountCleanup/);
  assert.match(repository, /set status = 'deleting'/i);
  assert.match(repository, /file_ingestion_jobs[\s\S]*status = 'cancelled'/i);
  assert.match(repository, /lease_expires_at = now\(\)/i);
  assert.match(repository, /insert into artifact_cleanup_jobs/i);
  assert.match(repository, /delete from sessions[\s\S]*where user_id/i);
  assert.match(repository, /for update/i);
  assert.match(fileEnqueue, /from users[\s\S]*for update[\s\S]*from files[\s\S]*for update/i);
  assert.match(projectEnqueue, /from users[\s\S]*for update[\s\S]*from project_spaces[\s\S]*for update/i);
});

test('cleanup claims and step checkpoints are fenced by a renewable lease', () => {
  const repository = readOptionalSource('src/repositories/cleanupJobs.ts');
  const queue = readOptionalSource('src/services/cleanupQueue.ts');

  assert.match(repository, /export const claimNextCleanupJob/);
  assert.match(repository, /for update skip locked/i);
  assert.match(repository, /lease_expires_at <= now\(\)/i);
  assert.match(repository, /export const renewCleanupJobLease/);
  assert.match(repository, /export const updateCleanupJobStep/);
  assert.match(repository, /export const failExhaustedCleanupJobs/);
  assert.match(repository, /export const claimCleanupJobById/);
  assert.match(repository, /attempts >= max_attempts[\s\S]*lease_expires_at <= now\(\)/i);
  assert.match(repository, /lease_token = \$[0-9]+[\s\S]*lease_expires_at > now\(\)/i);
  assert.match(queue, /failExhaustedCleanupJobs/);
  assert.match(
    queue,
    /failExhaustedCleanupJobs\(\)[\s\S]*listDispatchableCleanupJobIds/i,
    'the dispatcher must terminalize exhausted stale leases before publishing ready work',
  );
});

test('expired cleanup leases at the attempt limit become terminal safe failures', async () => {
  const repositoryPath = path.join(serverRoot, 'dist', 'repositories', 'cleanupJobs.js');
  const { failExhaustedCleanupJobs } = require(repositoryPath);
  assert.equal(typeof failExhaustedCleanupJobs, 'function');

  const calls = [];
  const count = await failExhaustedCleanupJobs({
    limit: 17,
    runQuery: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 'job-exhausted' }], rowCount: 1 };
    },
  });

  assert.equal(count, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [17]);
  assert.match(calls[0].sql, /status = 'processing'/i);
  assert.match(calls[0].sql, /attempts >= max_attempts/i);
  assert.match(calls[0].sql, /lease_expires_at <= now\(\)/i);
  assert.match(calls[0].sql, /set status = 'failed'/i);
  assert.match(calls[0].sql, /last_error = 'Artifact cleanup lease expired after maximum attempts'/i);
});

test('upload reservation rechecks active account and workspace under the deletion lock order', () => {
  const files = readSource('src/repositories/files.ts');
  const reserve = files.split('export const reserveUploadFile', 2)[1]
    ?.split('export const createUploadFile', 1)[0] || '';

  assert.match(reserve, /from users[\s\S]*deletion_status = 'active'[\s\S]*for update/i);
  assert.match(reserve, /from project_spaces[\s\S]*status = 'active'[\s\S]*for update/i);
  assert.match(files, /UPLOAD_PROJECT_NOT_FOUND/);
});

test('late upload publication cannot revive a deleting file and requeues object cleanup', () => {
  const files = readSource('src/repositories/files.ts');
  const update = files.split('export const updateFile', 2)[1]
    ?.split('export const deleteAbandonedUploadingFiles', 1)[0] || '';

  assert.match(update, /from files[\s\S]*for update/i);
  assert.match(update, /status === 'deleting'/i);
  assert.match(update, /requeueFileCleanupForStoredObject/);
  assert.match(files, /artifact_cleanup_jobs/i);
  assert.match(files, /set\s+status = 'queued'/i);
  assert.match(files, /step_state[\s\S]*storage_deleted/i);
  assert.match(files, /lease_token = null/i);
});

test('parallel generation migration permits durable generation cleanup jobs', () => {
  const migration = readSource('migrations/0034_parallel_conversion_generations.sql');

  assert.match(migration, /file_chunks_legacy_file_chunk_index_uidx/i);
  assert.match(migration, /file_chunks_generation_chunk_index_uidx/i);
  assert.match(migration, /resource_type in[\s\S]*'conversion_generation'/i);
});

test('file cleanup snapshots raw, multipart, and every conversion generation object key', async () => {
  const repositoryPath = path.join(serverRoot, 'dist', 'repositories', 'cleanupJobs.js');
  const { enqueueFileCleanup } = require(repositoryPath);
  const fileId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const rawKey = `users/${userId}/files/${fileId}/raw/original.pdf`;
  const multipartKey = `users/${userId}/files/${fileId}/raw/incomplete.pdf`;
  const statuses = ['converting', 'completed', 'completed_with_warnings', 'failed', 'superseded'];
  const generations = statuses.map((status, index) => ({
    status,
    source_object_key: index === 1 ? `${rawKey}.historical` : rawKey,
    markdown_object_key: `users/${userId}/files/${fileId}/derived/g-${index}/document.md`,
    source_map_object_key: `users/${userId}/files/${fileId}/derived/g-${index}/source-map.jsonl.zst`,
    manifest_object_key: index === 3
      ? null
      : `users/${userId}/files/${fileId}/derived/g-${index}/manifest.json`,
  }));
  const calls = [];
  let capturedPayload;
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/from users/i.test(sql)) return { rows: [{ id: userId }] };
      if (/select id, user_id, object_key[\s\S]*from files/i.test(sql)) {
        return { rows: [{ id: fileId, user_id: userId, object_key: rawKey }] };
      }
      if (/update files/i.test(sql)) return { rows: [] };
      if (/update file_ingestion_jobs/i.test(sql)) return { rows: [] };
      if (/from file_conversion_generations/i.test(sql)) return { rows: generations };
      if (/from upload_multipart_sessions/i.test(sql)) {
        return {
          rows: [{
            object_key: multipartKey,
            storage_upload_id: 'multipart-upload-id',
            status: 'uploading',
          }],
        };
      }
      if (/update upload_multipart_sessions/i.test(sql)) return { rows: [] };
      if (/insert into artifact_cleanup_jobs/i.test(sql)) {
        capturedPayload = JSON.parse(params[5]);
        return { rows: [{ id: 'cleanup-job', payload: capturedPayload }] };
      }
      throw new Error(`Unexpected cleanup query: ${sql}`);
    },
  };

  const result = await enqueueFileCleanup(fileId, userId, {
    runInTransaction: async (callback) => callback(client),
  });

  assert.equal(result.id, 'cleanup-job');
  assert.equal(capturedPayload.object_key, rawKey);
  assert.equal(capturedPayload.multipart_object_key, multipartKey);
  assert.equal(capturedPayload.multipart_upload_id, 'multipart-upload-id');
  assert.equal(new Set(capturedPayload.storage_object_keys).size, capturedPayload.storage_object_keys.length);
  assert.deepEqual(capturedPayload.storage_object_keys, [
    rawKey,
    multipartKey,
    generations[0].markdown_object_key,
    generations[0].source_map_object_key,
    generations[0].manifest_object_key,
    generations[1].source_object_key,
    generations[1].markdown_object_key,
    generations[1].source_map_object_key,
    generations[1].manifest_object_key,
    generations[2].markdown_object_key,
    generations[2].source_map_object_key,
    generations[2].manifest_object_key,
    generations[3].markdown_object_key,
    generations[3].source_map_object_key,
    generations[4].markdown_object_key,
    generations[4].source_map_object_key,
    generations[4].manifest_object_key,
  ]);

  const fileLockIndex = calls.findIndex(({ sql }) => /from files[\s\S]*for update/i.test(sql));
  const ingestionCancelIndex = calls.findIndex(({ sql }) => /update file_ingestion_jobs/i.test(sql));
  const generationIndex = calls.findIndex(({ sql }) => /from file_conversion_generations/i.test(sql));
  assert.ok(fileLockIndex >= 0 && fileLockIndex < ingestionCancelIndex);
  assert.ok(ingestionCancelIndex < generationIndex);
  assert.match(calls[generationIndex].sql, /where file_id = \$1\s+for update/i);
  assert.doesNotMatch(calls[generationIndex].sql, /where[\s\S]*status\s*(?:=|in\s*\()/i);
});

test('terminal candidate generations are retired and queued without the shared original key', async () => {
  const repositoryPath = path.join(serverRoot, 'dist', 'repositories', 'cleanupJobs.js');
  const { enqueueConversionGenerationCleanupWithClient } = require(repositoryPath);
  const fileId = '11111111-1111-4111-8111-111111111111';
  const generationId = '33333333-3333-4333-8333-333333333333';
  const userId = '22222222-2222-4222-8222-222222222222';
  const generation = {
    id: generationId,
    file_id: fileId,
    status: 'completed',
    markdown_object_key: 'derived/g/document.md',
    source_map_object_key: 'derived/g/source-map.jsonl.zst',
    manifest_object_key: 'derived/g/manifest.json',
  };
  let payload;
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/select[\s\S]*from file_conversion_generations generation/i.test(sql)) {
        return { rows: [generation] };
      }
      if (/update file_conversion_generations/i.test(sql)) {
        return { rows: [{ ...generation, status: 'superseded' }] };
      }
      if (/insert into artifact_cleanup_jobs/i.test(sql)) {
        payload = JSON.parse(params[5]);
        return { rows: [{ id: 'cleanup-generation', payload }] };
      }
      throw new Error(`Unexpected generation cleanup query: ${sql}`);
    },
  };

  const result = await enqueueConversionGenerationCleanupWithClient(client, {
    fileId,
    generationId,
    ownerUserId: userId,
    reason: 'ingestion_attempt_terminated',
  });

  assert.equal(result.id, 'cleanup-generation');
  assert.deepEqual(payload.storage_object_keys, [
    generation.markdown_object_key,
    generation.source_map_object_key,
    generation.manifest_object_key,
  ]);
  assert.equal(payload.file_id, fileId);
  assert.equal(JSON.stringify(payload).includes('raw/original'), false);
  assert.match(calls[0].sql, /active_conversion_generation_id is distinct from generation\.id/i);
  assert.match(calls[1].sql, /set status = 'superseded'/i);
});

test('generation cleanup checkpoints external indexes before derived storage and finalization', async () => {
  const servicePath = path.join(serverRoot, 'dist', 'services', 'cleanupQueue.js');
  const { executeArtifactCleanupJob } = require(servicePath);
  const calls = [];
  const job = {
    id: 'generation-job',
    resource_type: 'conversion_generation',
    resource_id: '33333333-3333-4333-8333-333333333333',
    lease_token: '44444444-4444-4444-8444-444444444444',
    step_state: {},
    payload: {
      file_id: '11111111-1111-4111-8111-111111111111',
      storage_object_keys: ['derived-md', 'derived-map', 'derived-manifest'],
    },
  };

  const result = await executeArtifactCleanupJob(job, {
    cleanupRagGeneration: async (input) => calls.push(`rag:${input.generationId}`),
    deleteStorageObject: async (key) => calls.push(`storage:${key}`),
    updateStep: async (_claim, step) => calls.push(`step:${step}`),
    finalizeConversionGeneration: async () => calls.push('finalize-generation'),
    markFailed: async () => calls.push('failed'),
    warn: () => undefined,
  });

  assert.deepEqual(result, { state: 'completed' });
  assert.deepEqual(calls, [
    `rag:${job.resource_id}`,
    'step:rag_deleted',
    'storage:derived-md',
    'storage:derived-map',
    'storage:derived-manifest',
    'step:storage_deleted',
    'finalize-generation',
  ]);
});

test('generation finalization refuses an active generation and preserves its row', async () => {
  const repositoryPath = path.join(serverRoot, 'dist', 'repositories', 'cleanupJobs.js');
  const { finalizeConversionGenerationCleanup } = require(repositoryPath);
  const generationId = '33333333-3333-4333-8333-333333333333';
  const fileId = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (/select id from files/i.test(sql)) return { rows: [{ id: fileId }] };
      if (/from file_conversion_generations generation/i.test(sql)) {
        return {
          rows: [{
            id: generationId,
            file_id: fileId,
            status: 'superseded',
            active_conversion_generation_id: generationId,
          }],
        };
      }
      if (/from artifact_cleanup_jobs/i.test(sql)) {
        return {
          rows: [{
            id: 'cleanup-job',
            resource_type: 'conversion_generation',
            resource_id: generationId,
          }],
        };
      }
      throw new Error(`Unexpected finalization query: ${sql}`);
    },
  };

  await assert.rejects(
    finalizeConversionGenerationCleanup({
      id: 'cleanup-job',
      lease_token: '44444444-4444-4444-8444-444444444444',
      resource_id: generationId,
      payload: { file_id: fileId },
    }, {
      runInTransaction: async (callback) => callback(client),
    }),
    /Active conversion generation cannot be finalized/,
  );
  assert.equal(calls.some((sql) => /delete from file_conversion_generations/i.test(sql)), false);
});

test('file cleanup worker deletes deduplicated snapshot and legacy keys before checkpointing', async () => {
  const servicePath = path.join(serverRoot, 'dist', 'services', 'cleanupQueue.js');
  const { executeArtifactCleanupJob, storageKeysFromPayload } = require(servicePath);
  const payload = {
    storage_object_keys: ['raw', 'derived-md', 'raw', null, 42, 'derived-map'],
    object_key: 'raw',
    multipart_object_key: 'multipart',
  };
  assert.deepEqual(storageKeysFromPayload(payload), [
    'raw',
    'derived-md',
    'derived-map',
    'multipart',
  ]);

  const calls = [];
  const result = await executeArtifactCleanupJob({
    id: 'job-snapshot',
    resource_type: 'file',
    resource_id: 'file-1',
    lease_token: '11111111-1111-4111-8111-111111111111',
    step_state: { rag_deleted: true, multipart_aborted: true },
    payload,
  }, {
    deleteStorageObject: async (key) => calls.push(`storage:${key}`),
    updateStep: async (_claim, step) => calls.push(`step:${step}`),
    finalizeFile: async () => calls.push('finalize-file'),
    markFailed: async () => calls.push('failed'),
    warn: () => undefined,
  });

  assert.deepEqual(calls, [
    'storage:raw',
    'storage:derived-md',
    'storage:derived-map',
    'storage:multipart',
    'step:storage_deleted',
    'finalize-file',
  ]);
  assert.deepEqual(result, { state: 'completed' });
});

test('file cleanup retries every storage key when deletion fails before its checkpoint', async () => {
  const servicePath = path.join(serverRoot, 'dist', 'services', 'cleanupQueue.js');
  const { executeArtifactCleanupJob } = require(servicePath);
  const job = {
    id: 'job-retry',
    resource_type: 'file',
    resource_id: 'file-1',
    lease_token: '11111111-1111-4111-8111-111111111111',
    step_state: { rag_deleted: true, multipart_aborted: true },
    payload: { storage_object_keys: ['raw', 'derived-md', 'derived-map'] },
  };
  const firstAttempt = [];
  const firstResult = await executeArtifactCleanupJob(job, {
    deleteStorageObject: async (key) => {
      firstAttempt.push(`storage:${key}`);
      if (key === 'derived-md') throw new Error('temporary storage failure');
    },
    updateStep: async (_claim, step) => firstAttempt.push(`step:${step}`),
    finalizeFile: async () => firstAttempt.push('finalize-file'),
    markFailed: async () => firstAttempt.push('failed'),
    warn: () => undefined,
  });
  assert.deepEqual(firstResult, { state: 'failed' });
  assert.deepEqual(firstAttempt, ['storage:raw', 'storage:derived-md', 'failed']);
  assert.equal(firstAttempt.includes('step:storage_deleted'), false);
  assert.equal(firstAttempt.includes('finalize-file'), false);

  const retryAttempt = [];
  const retryResult = await executeArtifactCleanupJob(job, {
    deleteStorageObject: async (key) => retryAttempt.push(`storage:${key}`),
    updateStep: async (_claim, step) => retryAttempt.push(`step:${step}`),
    finalizeFile: async () => retryAttempt.push('finalize-file'),
    markFailed: async () => retryAttempt.push('failed'),
    warn: () => undefined,
  });
  assert.deepEqual(retryResult, { state: 'completed' });
  assert.deepEqual(retryAttempt, [
    'storage:raw',
    'storage:derived-md',
    'storage:derived-map',
    'step:storage_deleted',
    'finalize-file',
  ]);
});

test('file cleanup resumes from durable completed steps with a legacy payload', async () => {
  const servicePath = path.join(serverRoot, 'dist', 'services', 'cleanupQueue.js');
  assert.equal(existsSync(servicePath), true, 'cleanup queue service is missing');
  const { executeArtifactCleanupJob } = require(servicePath);
  const calls = [];
  const job = {
    id: 'job-1',
    resource_type: 'file',
    resource_id: 'file-1',
    lease_token: '11111111-1111-4111-8111-111111111111',
    step_state: { rag_deleted: true, multipart_aborted: true },
    payload: { object_key: 'users/user-1/files/file-1/notes.md' },
  };

  const result = await executeArtifactCleanupJob(job, {
    cleanupRagFile: async () => calls.push('rag'),
    abortMultipartUpload: async () => calls.push('multipart'),
    deleteStorageObject: async (key) => calls.push(`storage:${key}`),
    updateStep: async (_claim, step) => calls.push(`step:${step}`),
    finalizeFile: async () => calls.push('finalize-file'),
    summarizeChildren: async () => ({ pending: 0, failed: 0 }),
    markWaiting: async () => calls.push('waiting'),
    finalizeProjectSpace: async () => calls.push('finalize-project'),
    finalizeAccount: async () => calls.push('finalize-account'),
    markFailed: async () => calls.push('failed'),
    warn: () => undefined,
  });

  assert.deepEqual(calls, [
    'storage:users/user-1/files/file-1/notes.md',
    'step:storage_deleted',
    'finalize-file',
  ]);
  assert.deepEqual(result, { state: 'completed' });
});

test('parent cleanup waits until every child file cleanup is complete', async () => {
  const servicePath = path.join(serverRoot, 'dist', 'services', 'cleanupQueue.js');
  assert.equal(existsSync(servicePath), true, 'cleanup queue service is missing');
  const { executeArtifactCleanupJob } = require(servicePath);
  const calls = [];
  const result = await executeArtifactCleanupJob({
    id: 'job-project',
    resource_type: 'project_space',
    resource_id: 'space-1',
    lease_token: '11111111-1111-4111-8111-111111111111',
    step_state: {},
    payload: {},
  }, {
    cleanupRagFile: async () => undefined,
    abortMultipartUpload: async () => undefined,
    deleteStorageObject: async () => undefined,
    updateStep: async () => undefined,
    finalizeFile: async () => calls.push('finalize-file'),
    summarizeChildren: async () => ({ pending: 1, failed: 0 }),
    markWaiting: async () => calls.push('waiting'),
    finalizeProjectSpace: async () => calls.push('finalize-project'),
    finalizeAccount: async () => calls.push('finalize-account'),
    markFailed: async () => calls.push('failed'),
    warn: () => undefined,
  });

  assert.deepEqual(calls, ['waiting']);
  assert.deepEqual(result, { state: 'waiting' });
});

test('cleanup failures persist a fixed safe message instead of downstream exception text', async () => {
  const servicePath = path.join(serverRoot, 'dist', 'services', 'cleanupQueue.js');
  assert.equal(existsSync(servicePath), true, 'cleanup queue service is missing');
  const { executeArtifactCleanupJob } = require(servicePath);
  const persisted = [];
  const secret = 'injected-storage-secret';

  const result = await executeArtifactCleanupJob({
    id: 'job-1',
    resource_type: 'file',
    resource_id: 'file-1',
    lease_token: '11111111-1111-4111-8111-111111111111',
    step_state: {},
    payload: {},
  }, {
    cleanupRagFile: async () => { throw new Error(secret); },
    abortMultipartUpload: async () => undefined,
    deleteStorageObject: async () => undefined,
    updateStep: async () => undefined,
    finalizeFile: async () => undefined,
    summarizeChildren: async () => ({ pending: 0, failed: 0 }),
    markWaiting: async () => undefined,
    finalizeProjectSpace: async () => undefined,
    finalizeAccount: async () => undefined,
    markFailed: async (_claim, message) => persisted.push(message),
    warn: () => undefined,
  });

  assert.deepEqual(result, { state: 'failed' });
  assert.equal(persisted.length, 1);
  assert.match(persisted[0], /Artifact cleanup failed/);
  assert.doesNotMatch(persisted[0], new RegExp(secret));
});

test('Nest services accept durable deletion before external cleanup and queue starts with the server', () => {
  const upload = readSource('src/modules/upload/upload.service.ts');
  const projects = readSource('src/modules/project-spaces/project-spaces.service.ts');
  const auth = readSource('src/modules/auth/auth.service.ts');
  const uploadController = readSource('src/modules/upload/upload.controller.ts');
  const projectController = readSource('src/modules/project-spaces/project-spaces.controller.ts');
  const authController = readSource('src/modules/auth/auth.controller.ts');
  const lifecycle = readSource('src/infrastructure/runtime-lifecycle.service.ts');

  assert.match(upload, /enqueueFileCleanup/);
  assert.match(projects, /enqueueProjectSpaceCleanup/);
  assert.match(auth, /enqueueAccountCleanup/);
  assert.match(upload, /statusCode:\s*202/);
  assert.match(projectController, /@HttpCode\(HttpStatus\.ACCEPTED\)/);
  assert.match(auth, /statusCode:\s*202/);
  assert.doesNotMatch(upload, /cleanupRagFileVectors/);
  assert.doesNotMatch(projects, /cleanupRagFileVectors/);
  assert.doesNotMatch(auth, /cleanupUserExternalArtifacts/);
  assert.match(uploadController, /@Delete\('files\/:id'\)[\s\S]*return this\.uploadService\.deleteFile\(user\.id, id, requestId\)/);
  assert.match(projectController, /@Delete\(':projectSpaceId'\)[\s\S]*return this\.projectSpacesService\.delete\(user\.id, projectSpaceId, requestId\)/);
  assert.match(authController, /@Delete\('me'\)[\s\S]*return this\.authService\.deleteAccount\(user, requestId\)/);
  assert.match(lifecycle, /const queues = \[fileQueue, ragEvalQueue, artifactCleanupQueue\]/);
  assert.match(lifecycle, /async onApplicationBootstrap\(\)[\s\S]*queues\.map\(\(queue\) => queue\.start\(\)\)/);
  assert.match(lifecycle, /shutdownRuntime\(\)[\s\S]*queues\.map\(\(queue\) => queue\.stop\(\)\)/);
});

test('authentication and refresh paths reject deletion-pending users', () => {
  const migration = readSource('migrations/0026_file_lifecycle_cleanup.sql');
  const users = readSource('src/repositories/users.ts');
  const sessions = readSource('src/repositories/sessions.ts');
  const authentication = readSource('src/services/authentication.ts');
  const authGuard = readSource('src/common/guards/auth.guard.ts');

  assert.match(migration, /deletion_status/);
  assert.match(users, /deletion_status/);
  assert.match(sessions, /deletion_status = 'active'/);
  assert.match(
    sessions,
    /select user_id[\s\S]*from sessions[\s\S]*from users[\s\S]*for update[\s\S]*delete from sessions/i,
  );
  assert.match(authentication, /deletion_status !== 'active'/);
  assert.match(authGuard, /resolveAuthenticatedUser\(accessToken\)/);
});

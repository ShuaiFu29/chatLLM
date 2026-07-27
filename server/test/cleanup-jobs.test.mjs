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

test('file cleanup resumes from durable completed steps', async () => {
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

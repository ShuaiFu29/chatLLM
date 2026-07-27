import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repositorySource = readFileSync(path.join(serverRoot, 'src/repositories/projectSpaces.ts'), 'utf8');
const handlerSource = readFileSync(path.join(serverRoot, 'src/controllers/projectSpaces.ts'), 'utf8');
const nestControllerSource = readFileSync(path.join(serverRoot, 'src/modules/project-spaces/project-spaces.controller.ts'), 'utf8');

test('deleting a workspace is finalized only after durable child cleanup', () => {
  const cleanupRepositoryPath = path.join(serverRoot, 'src/repositories/cleanupJobs.ts');
  assert.equal(existsSync(cleanupRepositoryPath), true, 'cleanup job repository is missing');
  const cleanupRepositorySource = existsSync(cleanupRepositoryPath)
    ? readFileSync(cleanupRepositoryPath, 'utf8')
    : '';
  assert.match(cleanupRepositorySource, /enqueueProjectSpaceCleanup/);
  assert.match(cleanupRepositorySource, /parent_job_id/);
  assert.match(cleanupRepositorySource, /finalizeProjectSpaceCleanup/);
  assert.match(cleanupRepositorySource, /delete from conversations/i);
  assert.match(cleanupRepositorySource, /delete from project_spaces/i);
  assert.doesNotMatch(repositorySource, /delete from files\s+where user_id/i);
});

test('workspace deletion controller enqueues cleanup without inline external calls', () => {
  assert.match(nestControllerSource, /@Controller\('project-spaces'\)/);
  assert.match(nestControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(
    nestControllerSource,
    /@Delete\(':projectSpaceId'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.projectSpaceDelete\)[\s\S]*?return deleteProjectSpace\(request, reply\)/,
  );
  assert.match(handlerSource, /enqueueProjectSpaceCleanup/);
  assert.match(handlerSource, /code\(202\)\.send/);
  assert.doesNotMatch(handlerSource, /cleanupRagFileVectors/);
  assert.doesNotMatch(handlerSource, /deleteObject/);
});

test('normal workspace lookups hide deleting rows while deletion remains idempotent', () => {
  const activeLookup = repositorySource.split('export const findProjectSpaceForUser', 2)[1]
    ?.split('export const findProjectSpaceForUserIncludingDeleting', 1)[0] || '';

  assert.match(activeLookup, /status = 'active'/i);
  assert.match(repositorySource, /export const findProjectSpaceForUserIncludingDeleting/);
  assert.match(handlerSource, /findProjectSpaceForUserIncludingDeleting/);
  const deleteController = handlerSource.split('export const deleteProjectSpace', 2)[1] || '';
  assert.match(deleteController, /findProjectSpaceForUserIncludingDeleting/);
});

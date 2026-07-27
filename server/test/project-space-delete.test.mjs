import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repositorySource = readFileSync(path.join(serverRoot, 'src/repositories/projectSpaces.ts'), 'utf8');
const nestControllerSource = readFileSync(path.join(serverRoot, 'src/modules/project-spaces/project-spaces.controller.ts'), 'utf8');
const serviceSource = readFileSync(path.join(serverRoot, 'src/modules/project-spaces/project-spaces.service.ts'), 'utf8');

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
    /@Delete\(':projectSpaceId'\)[\s\S]*?@HttpCode\(HttpStatus\.ACCEPTED\)[\s\S]*?@ValidateMutation\(mutationSchemas\.projectSpaceDelete\)[\s\S]*?this\.projectSpacesService\.delete\(user\.id, projectSpaceId, requestId\)/,
  );
  assert.match(serviceSource, /enqueueProjectSpaceCleanup/);
  assert.match(nestControllerSource, /@CurrentUser\(\) user: User/);
  assert.doesNotMatch(nestControllerSource, /@(?:Req|Res)\(|App(?:Request|Reply)|controllers\/projectSpaces/);
  assert.doesNotMatch(serviceSource, /cleanupRagFileVectors/);
  assert.doesNotMatch(serviceSource, /deleteObject/);
});

test('normal workspace lookups hide deleting rows while deletion remains idempotent', () => {
  const activeLookup = repositorySource.split('export const findProjectSpaceForUser', 2)[1]
    ?.split('export const findProjectSpaceForUserIncludingDeleting', 1)[0] || '';

  assert.match(activeLookup, /status = 'active'/i);
  assert.match(repositorySource, /export const findProjectSpaceForUserIncludingDeleting/);
  assert.match(serviceSource, /findProjectSpaceForUserIncludingDeleting/);
  const deleteController = serviceSource.split('async delete', 2)[1] || '';
  assert.match(deleteController, /findProjectSpaceForUserIncludingDeleting/);
});

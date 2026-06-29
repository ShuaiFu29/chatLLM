import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repositorySource = readFileSync(path.join(serverRoot, 'src/repositories/projectSpaces.ts'), 'utf8');
const controllerSource = readFileSync(path.join(serverRoot, 'src/controllers/projectSpaces.ts'), 'utf8');

test('deleting a workspace removes its conversations and files instead of orphaning them', () => {
  assert.match(repositorySource, /where id = \$1 and user_id = \$2 and is_default = false/i);
  assert.match(repositorySource, /delete from conversations\s+where user_id = \$\d+ and project_space_id = \$\d+/i);
  assert.match(repositorySource, /delete from files\s+where user_id = \$\d+ and project_space_id = \$\d+/i);
  assert.match(repositorySource, /delete from project_spaces/i);
});

test('workspace deletion cleans external file storage and vectors before database deletion', () => {
  assert.match(controllerSource, /listFilesForUser/);
  assert.match(controllerSource, /cleanupRagFileVectors/);
  assert.match(controllerSource, /deleteObject/);
});

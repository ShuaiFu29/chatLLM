import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const { getMigrationFileNames } = require(path.join(serverRoot, 'dist', 'lib', 'migrations.js'));

test('getMigrationFileNames returns sql migrations in stable order', () => {
  assert.deepEqual(
    getMigrationFileNames(['0002_project_spaces.sql', 'notes.txt', '0001_init.sql']),
    ['0001_init.sql', '0002_project_spaces.sql']
  );
});

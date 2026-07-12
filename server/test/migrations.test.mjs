import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
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

test('security migration replaces raw refresh tokens with surrogate ids and unique hashes', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0025_security_sessions_rate_limits.sql');
  assert.equal(existsSync(migrationPath), true, '0025 security migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /alter table sessions add column if not exists token_hash text/i);
  assert.match(sql, /encode\s*\(\s*sha256\s*\(\s*convert_to\s*\(\s*id::text,\s*'UTF8'\s*\)\s*\)\s*,\s*'hex'\s*\)/i);
  assert.match(sql, /alter table sessions\s+add column if not exists session_id uuid[^;]*default gen_random_uuid\(\)/i);
  assert.match(sql, /alter table sessions drop constraint if exists sessions_pkey/i);
  assert.match(sql, /alter table sessions drop column id/i);
  assert.match(sql, /alter table sessions rename column session_id to id/i);
  assert.match(sql, /alter table sessions add primary key \(id\)/i);
  assert.match(sql, /alter table sessions alter column token_hash set not null/i);
  assert.match(sql, /check\s*\(\s*char_length\(token_hash\)\s*=\s*64\s*\)/i);
  assert.match(sql, /create unique index[^;]*sessions\s*\(token_hash\)/i);
  assert.doesNotMatch(sql, /raw_token|refresh_token/i);
});

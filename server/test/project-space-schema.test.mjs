import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const migration = readFileSync(path.join(serverRoot, 'migrations', '0001_init.sql'), 'utf8');

test('schema defines project spaces owned by users', () => {
  assert.match(migration, /create table if not exists project_spaces/i);
  assert.match(migration, /user_id uuid not null references users\(id\) on delete cascade/i);
  assert.match(migration, /name text not null/i);
  assert.match(migration, /is_default boolean not null default false/i);
});

test('conversations and files belong to optional project spaces', () => {
  assert.match(migration, /project_space_id uuid references project_spaces\(id\) on delete set null/i);
  assert.match(migration, /conversations_user_id_project_space_id_updated_at_idx/i);
  assert.match(migration, /files_user_id_project_space_id_created_at_idx/i);
});

test('base schema migration backfills project space columns for existing local tables', () => {
  assert.match(migration, /alter table conversations\s+add column if not exists project_space_id/i);
  assert.match(migration, /alter table files\s+add column if not exists project_space_id/i);
  assert.match(migration, /alter table messages\s+add column if not exists sources/i);
});

test('assistant messages can persist source references', () => {
  assert.match(migration, /sources jsonb not null default '\[\]'::jsonb/i);
});

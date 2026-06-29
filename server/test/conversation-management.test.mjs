import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const initMigration = readFileSync(path.join(serverRoot, 'migrations', '0001_init.sql'), 'utf8');
const managementMigration = readFileSync(path.join(serverRoot, 'migrations', '0003_conversation_management.sql'), 'utf8');
const repositorySource = readFileSync(path.join(serverRoot, 'src/repositories/conversations.ts'), 'utf8');
const controllerSource = readFileSync(path.join(serverRoot, 'src/controllers/chat.ts'), 'utf8');

test('conversation schema supports pinning and archiving for new and existing databases', () => {
  assert.match(initMigration, /is_pinned boolean not null default false/i);
  assert.match(initMigration, /archived_at timestamptz/i);
  assert.match(managementMigration, /alter table conversations\s+add column if not exists is_pinned boolean not null default false/i);
  assert.match(managementMigration, /alter table conversations\s+add column if not exists archived_at timestamptz/i);
  assert.match(managementMigration, /conversations_user_id_project_space_archived_pinned_updated_idx/i);
});

test('conversation listing defaults to active conversations and sorts pinned conversations first', () => {
  assert.match(repositorySource, /includeArchived\?: boolean/);
  assert.match(repositorySource, /archived_at is null/i);
  assert.match(repositorySource, /order by is_pinned desc, updated_at desc/i);
});

test('conversation updates allow pin and archive state changes for the current user only', () => {
  assert.match(repositorySource, /'is_pinned' \| 'archived_at'/);
  assert.match(controllerSource, /is_pinned/);
  assert.match(controllerSource, /archived/);
  assert.match(controllerSource, /updates\.archived_at = archived \? new Date\(\)\.toISOString\(\) : null/);
});

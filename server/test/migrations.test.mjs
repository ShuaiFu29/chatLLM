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

test('local auth migration supports local identities and explicit remember-me sessions', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0031_local_auth.sql');
  assert.equal(existsSync(migrationPath), true, '0031 local auth migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /alter table users alter column github_id drop not null/i);
  assert.match(sql, /add column if not exists email text/i);
  assert.match(sql, /add column if not exists password_hash text/i);
  assert.match(sql, /email = lower\(btrim\(email\)\)/i);
  assert.match(sql, /users_local_credentials_pair_check/i);
  assert.match(sql, /users_login_method_check/i);
  assert.match(sql, /password_hash like 'scrypt\$v1\$%'/i);
  assert.match(sql, /create unique index[^;]*users_email_unique_idx[^;]*on users\(email\)/i);
  assert.match(sql, /add column if not exists remember_me boolean not null default true/i);
  assert.match(sql, /alter column remember_me set default false/i);
});

test('Agent migration keeps user configuration, versions, tools, runs, and steps scoped and indexed', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0036_user_configurable_agents.sql');
  assert.equal(existsSync(migrationPath), true, '0036 Agent migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  for (const table of ['agents', 'agent_versions', 'agent_tools', 'agent_runs', 'agent_steps', 'agent_approvals']) {
    assert.match(sql, new RegExp(`create table if not exists ${table}`, 'i'));
  }
  assert.match(sql, /agent_versions_agent_version_unique unique \(agent_id, version\)/i);
  assert.match(sql, /agent_tools_configuration_object_check/i);
  assert.match(sql, /agent_steps_run_sequence_unique unique \(run_id, sequence\)/i);
  assert.match(sql, /alter table conversations\s+add column if not exists agent_id uuid/i);
  assert.match(sql, /conversations_agent_id_fkey/i);
  assert.match(sql, /create index if not exists agent_runs_conversation_created_idx/i);
  assert.match(sql, /create index if not exists agent_runs_assistant_message_created_idx/i);
  assert.match(sql, /create index if not exists agent_approvals_step_id_idx/i);
  assert.match(sql, /where status in \('queued', 'running', 'waiting_approval'\)/i);
});

test('Agent integrity migration snapshots versions and adds foreign-key indexes', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0037_agent_integrity_and_indexes.sql');
  assert.equal(existsSync(migrationPath), true, '0037 Agent integrity migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /add column if not exists agent_version_snapshot jsonb/i);
  assert.match(sql, /agent_runs_agent_version_snapshot_object_check/i);
  assert.match(sql, /agents_project_space_id_idx/i);
  assert.match(sql, /agent_tools_project_space_id_idx/i);
  assert.match(sql, /agent_runs_agent_version_id_idx/i);
  assert.match(sql, /agent_approvals_user_id_idx/i);
});

test('Agent grounding migration stores only an object-shaped verification summary', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0041_agent_grounding_summary.sql');
  assert.equal(existsSync(migrationPath), true, '0041 Agent grounding migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /alter table agent_runs\s+add column if not exists grounding jsonb/i);
  assert.match(sql, /agent_runs_grounding_object_check/i);
  assert.match(sql, /grounding is null or jsonb_typeof\(grounding\) = 'object'/i);
});

test('Agent pre-run cancellation migration scopes stop intents to the exact user message', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0042_agent_pre_run_cancellation.sql');
  assert.equal(existsSync(migrationPath), true, '0042 Agent cancellation migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /create table if not exists agent_run_cancel_intents/i);
  assert.match(sql, /user_message_id uuid primary key references messages\(id\) on delete cascade/i);
  assert.match(sql, /conversation_id uuid not null references conversations\(id\) on delete cascade/i);
  assert.match(sql, /user_id uuid not null references users\(id\) on delete cascade/i);
  assert.match(sql, /agent_run_cancel_intents_expires_idx/i);
});

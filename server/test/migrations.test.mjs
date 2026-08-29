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

test('Agent tool outcome migration separates definite failure from unknown side effects', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0054_agent_tool_outcome_integrity.sql');
  assert.equal(existsSync(migrationPath), true, '0054 Agent tool outcome migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /add column if not exists retry_mode text not null default 'never'/i);
  assert.match(sql, /add column if not exists error_code text/i);
  assert.match(sql, /status in \('in_flight', 'succeeded', 'failed', 'indeterminate'\)/i);
  assert.match(sql, /retry_mode in \('safe_read', 'idempotent_write', 'never'\)/i);
  assert.match(sql, /agent_tool_invocations_terminal_metadata_check/i);
  assert.match(sql, /status in \('failed', 'indeterminate'\) and completed_at is not null and error_code is not null/i);
});

test('Agent subagent waiting lease migration preserves fenced ownership', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0055_agent_subagent_waiting_lease.sql');
  assert.equal(existsSync(migrationPath), true, '0055 Agent subagent waiting lease migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /parent_run_id is not null[\s\S]*status = 'waiting_subagent'[\s\S]*lease_token is null/i);
  assert.match(sql, /status in \('running', 'waiting_subagent'\) and lease_token is not null/i);
  assert.match(sql, /status not in \('running', 'waiting_subagent'\) and lease_token is null/i);
  assert.match(sql, /error_code = case[\s\S]*'subagent_lease_lost'[\s\S]*'agent_run_parent_ended'/i);
  assert.match(sql, /update agent_approvals[\s\S]*requested_by_run_id in \(select id from orphaned_subtree\)/i);
  assert.match(sql, /update agent_steps[\s\S]*run_id in \(select id from orphaned_subtree\)/i);
});

test('Agent tool execution migration fences concurrent and stale runtimes', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0056_agent_tool_execution_fencing.sql');
  assert.equal(existsSync(migrationPath), true, '0056 Agent tool execution fencing migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /add column if not exists execution_token uuid/i);
  assert.match(sql, /where status = 'in_flight'/i);
  assert.match(sql, /status = 'indeterminate'/i);
  assert.match(sql, /error_code = 'tool_execution_owner_lost'/i);
  assert.match(sql, /alter column execution_token set not null/i);
});

test('Agent tree budget reservation migration prevents concurrent model overspend', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0057_agent_tree_budget_reservations.sql');
  assert.equal(existsSync(migrationPath), true, '0057 Agent tree budget reservation migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /add column if not exists token_reserved integer not null default 0/i);
  assert.match(sql, /token_consumed \+ token_reserved <= token_total/i);
  assert.match(sql, /create table if not exists agent_model_invocations/i);
  assert.match(sql, /create unique index if not exists agent_runs_id_root_unique_idx/i);
  assert.match(sql, /foreign key \(run_id, root_run_id\)[\s\S]*references agent_runs\(id, root_run_id\)/i);
  assert.match(sql, /status in \('reserved', 'succeeded', 'failed', 'indeterminate'\)/i);
  assert.match(sql, /usage_source is null or usage_source in/i);
  assert.match(sql, /reservation_conservative/i);
  assert.match(sql, /where status = 'reserved'/i);
});

test('Agent checkpoint migration versions and bounds durable continuation state', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0058_agent_run_checkpoints.sql');
  assert.equal(existsSync(migrationPath), true, '0058 Agent checkpoint migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /create table if not exists agent_run_checkpoints/i);
  assert.match(sql, /foreign key \(run_id, root_run_id\)[\s\S]*references agent_runs\(id, root_run_id\)/i);
  assert.match(sql, /generation bigint not null/i);
  assert.match(sql, /format_version = 1/i);
  assert.match(sql, /jsonb_typeof\(payload\) = 'object'/i);
  assert.match(sql, /state_hash text not null/i);
  assert.match(sql, /agent_run_checkpoints_state_hash_check/i);
  assert.match(sql, /state_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /octet_length\(payload::text\) <= 262144/i);
  assert.match(sql, /'model_ready'[\s\S]*'tool_batch_ready'[\s\S]*'approval_wait'/i);
});

test('Agent work item migration makes PostgreSQL the fenced queue source of truth', () => {
  const migrationPath = path.join(serverRoot, 'migrations', '0059_agent_work_items.sql');
  assert.equal(existsSync(migrationPath), true, '0059 Agent work item migration is missing');

  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /create table if not exists agent_work_items/i);
  assert.match(sql, /unique \(run_id\)/i);
  assert.match(sql, /foreign key \(run_id, root_run_id\)[\s\S]*references agent_runs\(id, root_run_id\)/i);
  assert.match(sql, /payload_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /octet_length\(payload::text\) <= 262144/i);
  assert.match(sql, /fencing_generation bigint not null default 0/i);
  assert.match(sql, /status = 'running' and lease_token is not null and fencing_generation > 0/i);
  assert.match(sql, /agent_work_items_dispatch_task_unique_idx/i);
  assert.match(sql, /where status = 'queued'/i);
  assert.match(sql, /sync_agent_work_item_terminal_state/i);
});

test('Agent Step sequence migration seeds a durable monotonic allocator', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0060_agent_step_sequence_allocator.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0060 Agent Step allocator migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /add column if not exists next_step_sequence bigint not null default 0/i);
  assert.match(sql, /select max\(step\.sequence\)::bigint \+ 1/i);
  assert.match(sql, /agent_runs_next_step_sequence_check/i);
});

test('Agent model invocation result migration bounds recoverable provider output', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0061_agent_model_invocation_results.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0061 model result migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /add column if not exists result_format_version smallint/i);
  assert.match(sql, /add column if not exists result_payload jsonb/i);
  assert.match(sql, /add column if not exists result_hash text/i);
  assert.match(sql, /result_format_version = 1/i);
  assert.match(sql, /jsonb_typeof\(result_payload\) = 'object'/i);
  assert.match(sql, /result_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /octet_length\(result_payload::text\) <= 262144/i);
  assert.match(sql, /'not_invoked'/i);
});

test('Agent tool invocation result migration prevents successful side-effect replay', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0062_agent_tool_invocation_results.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0062 tool result migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /add column if not exists result_format_version smallint/i);
  assert.match(sql, /add column if not exists result_payload jsonb/i);
  assert.match(sql, /add column if not exists result_hash text/i);
  assert.match(sql, /status = 'succeeded'/i);
  assert.match(sql, /jsonb_typeof\(result_payload -> 'modelContent'\) = 'string'/i);
  assert.match(sql, /result_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /octet_length\(result_payload::text\) <= 262144/i);
});

test('Agent work item payload hashes use PostgreSQL jsonb canonical text', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0063_agent_work_item_payload_hash.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0063 work payload hash migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /digest\(payload::text, 'sha256'\)/i);
  assert.match(sql, /set payload_hash = encode/i);
});

test('Agent tool budget debit migration makes recovery charges exactly once', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0064_agent_tool_budget_debits.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0064 tool budget debit migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /create table if not exists agent_tool_budget_debits/i);
  assert.match(sql, /primary key \(run_id, tool_call_id\)/i);
  assert.match(sql, /foreign key \(run_id, root_run_id\)[\s\S]*references agent_runs\(id, root_run_id\)/i);
  assert.match(sql, /length\(tool_call_id\) between 1 and 512/i);
});

test('Agent model exposure migration conservatively fences legacy reservations', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0065_agent_model_exposure_fencing.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0065 model exposure migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /add column if not exists exposure_started_at timestamptz/i);
  assert.match(sql, /set exposure_started_at = created_at/i);
  assert.match(sql, /where status = 'reserved' and exposure_started_at is null/i);
  assert.match(sql, /agent_model_invocations_unexposed_idx/i);

  const repositorySource = readFileSync(
    path.join(serverRoot, 'src', 'repositories', 'agentRunBudgets.ts'),
    'utf8',
  );
  assert.match(repositorySource, /failUnexposedAgentModelInvocation/);
  assert.match(repositorySource, /when candidates\.exposure_started_at is null then 'failed'/i);
  assert.match(repositorySource, /when candidates\.exposure_started_at is null then 0/i);
  assert.match(repositorySource, /else 'reservation_conservative'/i);
});

test('Agent execution-ready migration admits the generation-one recovery boundary', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0066_agent_execution_ready_checkpoint.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0066 execution-ready migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /drop constraint if exists agent_run_checkpoints_boundary_check/i);
  assert.match(sql, /add constraint agent_run_checkpoints_boundary_check check/i);
  assert.match(sql, /'execution_ready'[^]*'model_ready'[^]*'final_answer_ready'/i);

  const recoverySql = readFileSync(
    path.join(serverRoot, 'src', 'repositories', 'agentRecoverySql.ts'),
    'utf8',
  );
  assert.match(recoverySql, /checkpoint\.run_id is null/i);
  assert.match(recoverySql, /initial_execution,optional_history_count/i);
  assert.match(recoverySql, /checkpoint\.boundary = 'execution_ready'/i);
});

test('Agent event log migration provides bounded idempotent cursor replay', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0067_agent_run_events.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0067 Agent event log migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /create table if not exists agent_run_events/i);
  assert.match(sql, /id bigint generated always as identity primary key/i);
  assert.match(sql, /foreign key \(run_id, root_run_id\)[^]*references agent_runs\(id, root_run_id\)/i);
  assert.match(sql, /jsonb_typeof\(payload\) = 'object'/i);
  assert.match(sql, /octet_length\(payload::text\) <= 262144/i);
  assert.match(sql, /unique \(run_id, event_key\)/i);
  assert.match(sql, /agent_run_events_run_cursor_idx/i);
});

test('Agent subagent dispatch manifest migration pins crash-recoverable fan-out batches', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0068_agent_subagent_dispatch_manifests.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0068 dispatch manifest migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /create table if not exists agent_subagent_dispatches/i);
  assert.match(sql, /unique \(parent_run_id, parent_tool_call_id\)/i);
  assert.match(sql, /foreign key \(parent_run_id, root_run_id\)[^]*references agent_runs\(id, root_run_id\)/i);
  assert.match(sql, /octet_length\(plan::text\) <= 262144/i);
  assert.match(sql, /plan_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /status in \('planned', 'materializing', 'materialized'\)/i);
  assert.match(sql, /next_task_index/i);
  assert.match(sql, /created_child_count/i);
  assert.match(sql, /expected_child_count/i);
  assert.match(sql, /next_task_index <= jsonb_array_length\(plan->'tasks'\)/i);
  assert.match(sql, /created_child_count <= next_task_index/i);
  assert.match(sql, /expected_child_count = created_child_count/i);
});

test('Agent terminal event trigger covers every database terminalization path', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0069_agent_terminal_event_trigger.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0069 terminal event trigger migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  assert.match(sql, /create or replace function append_agent_run_terminal_event/i);
  assert.match(sql, /after update of status on agent_runs/i);
  assert.match(sql, /old\.status in \('queued', 'running', 'waiting_approval', 'waiting_subagent'\)/i);
  assert.match(sql, /new\.status in \('succeeded', 'failed', 'cancelled'\)/i);
  assert.match(sql, /'terminalFallback', true/i);
  assert.match(sql, /'subagent\.completed'/i);
  assert.match(sql, /on conflict \(run_id, event_key\) do nothing/i);

  const repositorySource = readFileSync(
    path.join(serverRoot, 'src', 'repositories', 'agentRunEvents.ts'),
    'utf8',
  );
  assert.match(repositorySource, /on conflict \(run_id, event_key\) do update/i);
  assert.match(repositorySource, /where event\.payload @> '\{"terminalFallback":true\}'::jsonb/i);
});

test('Agent version governance migration makes configuration and publication history immutable', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0070_agent_version_governance.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0070 Agent version governance migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /add column if not exists configuration_hash text/i);
  assert.match(sql, /compute_agent_version_configuration_hash/i);
  assert.match(sql, /update agent_versions version_row[^]*compute_agent_version_configuration_hash\(version_row\)/i);
  assert.match(sql, /jsonb_build_object\([^]*'instructions'[^]*'suggested_prompts'/i);
  assert.match(sql, /digest\([^]*'sha256'/i);
  assert.match(sql, /configuration_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /add column if not exists derived_from_version_id uuid/i);
  assert.match(sql, /change_kind in \('created', 'edited', 'rollback'\)/i);
  assert.match(sql, /foreign key \(derived_from_version_id, agent_id\)[^]*references agent_versions\(id, agent_id\)/i);
  assert.match(sql, /before update on agent_versions[^]*reject_agent_version_update/i);
  assert.match(sql, /create table if not exists agent_version_publications/i);
  assert.match(sql, /foreign key \(agent_version_id, agent_id\)[^]*references agent_versions\(id, agent_id\)/i);
  assert.match(sql, /jsonb_typeof\(validation_report -> 'checks'\) = 'array'/i);
});

test('Agent Memory Policy migration versions execution semantics and recomputes fingerprints', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0071_agent_memory_policy.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0071 Agent Memory Policy migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /add column if not exists memory_policy jsonb/i);
  assert.match(sql, /legacy_agent_memory_policy/i);
  assert.match(sql, /project_agent_memory_mode/i);
  assert.match(sql, /valid_agent_memory_policy/i);
  assert.match(sql, /memory_mode in \('none', 'conversation', 'user', 'project', 'custom'\)/i);
  assert.match(sql, /'format_version', 2/i);
  assert.match(sql, /'memory_policy', version_row\.memory_policy/i);
  assert.match(sql, /drop trigger if exists agent_versions_immutable_trigger/i);
  assert.match(sql, /update agent_versions version_row[^]*configuration_hash = compute_agent_version_configuration_hash\(version_row\)/i);
  assert.match(sql, /create trigger agent_versions_immutable_trigger/i);
});

test('Agent tool version migration pins immutable executable definitions and credentials', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0072_agent_tool_versions.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0072 Agent tool version migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /create table if not exists agent_tool_versions/i);
  assert.match(sql, /add column if not exists current_version_id uuid/i);
  assert.match(sql, /secret_version integer not null default 1/i);
  assert.match(sql, /configuration_hash text/i);
  assert.match(sql, /foreign key \(derived_from_version_id, tool_id\)[^]*references agent_tool_versions\(id, tool_id\)/i);
  assert.match(sql, /foreign key \(current_version_id, id\)[^]*references agent_tool_versions\(id, tool_id\)/i);
  assert.match(sql, /before update on agent_tool_versions[^]*reject_agent_tool_version_update/i);
  assert.match(sql, /binding\.value \|\| jsonb_build_object\('tool_version_id', tool\.current_version_id\)/i);
  assert.match(sql, /valid_versioned_agent_tool_bindings/i);
  assert.match(sql, /binding \? 'tool_version_id'/i);
  assert.match(sql, /'format_version', 3/i);
  assert.match(sql, /'tool_bindings', version_row\.tool_bindings/i);
  assert.match(sql, /agent_tools_user_name_lower_active_unique_idx/i);
  assert.match(sql, /where deleted_at is null/i);
});

test('Agent delegation migration backfills legacy dispatch safely and fingerprints explicit catalogs', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0073_agent_delegation_bindings.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0073 Agent delegation migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  const firstBackfill = sql.indexOf('update agent_versions version_row');
  const immutableDrop = sql.indexOf('drop trigger if exists agent_versions_immutable_trigger');
  const hashTriggerDrop = sql.indexOf('drop trigger if exists agent_versions_configuration_hash_trigger');
  assert.ok(immutableDrop >= 0 && immutableDrop < firstBackfill);
  assert.ok(hashTriggerDrop >= 0 && hashTriggerDrop < firstBackfill);
  assert.match(sql, /set delegation_mode = 'legacy_dynamic'[^]*'dispatch_subagents'/i);
  assert.match(sql, /valid_agent_delegation_bindings/i);
  assert.match(sql, /binding - array\[[^]*'allowed_context_keys'[^]*\]::text\[\] <> '\{\}'::jsonb/i);
  assert.match(sql, /delegation aliases must be unique|alias_value = any\(seen_aliases\)/i);
  assert.match(sql, /context_key = any\(seen_context_keys\)/i);
  assert.match(sql, /exception when others then\s+return false/i);
  assert.match(sql, /dispatch_enabled[^]*jsonb_array_length\(delegation_bindings\) > 0/i);
  assert.match(sql, /not dispatch_enabled[^]*jsonb_array_length\(delegation_bindings\) = 0/i);
  assert.match(sql, /'format_version', 4/i);
  assert.match(sql, /'delegation_mode', version_row\.delegation_mode/i);
  assert.match(sql, /'delegation_bindings', version_row\.delegation_bindings/i);
  assert.match(sql, /update agent_versions version[^]*configuration_hash = compute_agent_version_configuration_hash/i);
  assert.match(sql, /create trigger agent_versions_immutable_trigger/i);
});

test('Agent version dry-run migration isolates previews from production Run trees', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0074_agent_version_dry_runs.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0074 Agent dry-run migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /create table if not exists agent_version_dry_runs/i);
  assert.match(sql, /foreign key \(agent_version_id, agent_id\)[^]*references agent_versions\(id, agent_id\)/i);
  assert.match(sql, /status in \('running', 'succeeded', 'failed'\)/i);
  assert.match(sql, /isolation_report ->> 'mode' = 'model_only'/i);
  assert.match(sql, /jsonb_typeof\(planned_tool_calls\) = 'array'/i);
  assert.match(sql, /jsonb_array_length\(planned_tool_calls\) <= 24/i);
  assert.match(sql, /usage ->> 'total_tokens' ~ '\^\[0-9\]\+\$'/i);
  assert.match(sql, /status = 'failed'[^]*failure_code is not null[^]*failure_message is not null/i);
  assert.doesNotMatch(sql, /references conversations/i);
  assert.doesNotMatch(sql, /references messages/i);
  assert.doesNotMatch(sql, /references agent_runs/i);
});

test('Agent version evaluation migration pins paired snapshots and fixture-only results', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0075_agent_version_evaluations.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0075 Agent Eval migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /create table if not exists agent_eval_datasets/i);
  assert.match(sql, /create table if not exists agent_eval_cases/i);
  assert.match(sql, /create table if not exists agent_eval_runs/i);
  assert.match(sql, /create table if not exists agent_eval_run_cases/i);
  assert.match(sql, /create table if not exists agent_eval_results/i);
  assert.match(sql, /dataset_revision bigint not null/i);
  assert.match(sql, /candidate_agent_version_id uuid not null/i);
  assert.match(sql, /baseline_agent_version_id uuid/i);
  assert.match(sql, /candidate_configuration_hash text not null/i);
  assert.match(sql, /evaluator_version text not null/i);
  assert.match(sql, /agent_eval_runs_snapshot_guard/i);
  assert.match(sql, /agent_eval_run_cases_immutable_guard/i);
  assert.match(sql, /agent_eval_results_variant_guard/i);
  assert.match(sql, /agent_eval_results_immutable_guard/i);
  assert.match(sql, /evaluation_spec <> '\{\}'::jsonb/i);
  assert.match(sql, /lease_token uuid/i);
  assert.match(sql, /usage \?& array\['prompt_tokens', 'completion_tokens', 'total_tokens'\]/i);
  assert.match(sql, /jsonb_typeof\(usage -> 'prompt_tokens'\) = 'number'/i);
  assert.match(sql, /usage ->> 'total_tokens' ~ '\^\[0-9\]\+\$'/i);
  assert.match(sql, /status = 'failed'[^]*failure_code is not null[^]*failure_message is not null/i);
  assert.match(sql, /agent_eval_runs_active_without_baseline_unique_idx/i);
  assert.match(sql, /agent_eval_runs_active_with_baseline_unique_idx/i);
  assert.doesNotMatch(sql, /references conversations/i);
  assert.doesNotMatch(sql, /references messages/i);
  assert.doesNotMatch(sql, /references agent_runs/i);
  assert.doesNotMatch(sql, /references agent_tool_invocations/i);
});

test('Agent Memory governance migration quarantines candidates and appends evidence events', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0076_agent_memory_governance.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0076 Agent Memory governance migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /status in \('candidate', 'confirmed', 'rejected'\)/i);
  assert.match(sql, /source_trust = 'tool_derived'[\s\S]*then 'candidate'/i);
  assert.match(sql, /confidence between 0 and 1/i);
  assert.match(sql, /recall_count > 0 and last_recalled_at is not null/i);
  assert.match(sql, /create table if not exists agent_memory_evidence/i);
  assert.match(sql, /create table if not exists agent_memory_events/i);
  assert.match(sql, /agent_memory_evidence_immutable_guard/i);
  assert.match(sql, /agent_memory_events_immutable_guard/i);
  assert.match(sql, /before update or delete on agent_memory_events/i);
  assert.match(sql, /pg_trigger_depth\(\) > 1/i);
  assert.match(sql, /validate_agent_memory_audit_source/i);
  assert.match(
    sql,
    /where status = 'confirmed'[\s\S]*verification_status = 'legacy_confirmed'[\s\S]*verified_at is null/i,
  );
  assert.match(sql, /insert into agent_memory_evidence[\s\S]*'legacy'/i);
  assert.match(sql, /event\.details @> '\{"migration":"0076"\}'::jsonb/i);
  assert.match(
    sql,
    /if tg_op = 'INSERT'[\s\S]*new\.source_trust = 'tool_derived'[\s\S]*new\.status := 'candidate'/i,
  );
  assert.doesNotMatch(
    sql,
    /new\.source_trust = 'tool_derived'[\s\S]{0,160}new\.verification_status = 'legacy_confirmed'/i,
    'direct SQL must not bypass quarantine by claiming a verified tool-derived row',
  );
  assert.match(sql, /only a confirmed Agent memory can be superseded/i);
  assert.match(sql, /where status = 'confirmed' and superseded_by is null and deleted_at is null/i);
});

test('Agent Memory scope controls enforce user gates and active-row quotas in PostgreSQL', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0077_agent_memory_scope_controls.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0077 Agent Memory scope migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /create table if not exists agent_memory_scope_settings/i);
  assert.match(sql, /primary key \(user_id, scope\)/i);
  assert.match(sql, /max_active_memories between 1 and 5000/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /agent_memories_scope_enabled_check/i);
  assert.match(sql, /agent_memories_scope_quota_check/i);
  assert.match(sql, /before insert on agent_memories/i);
  assert.match(sql, /status in \('candidate', 'confirmed'\)/i);
  assert.match(sql, /md5\(existing\.content\) = md5\(new\.content\)/i);
});

test('Agent approval intent migration binds decisions to immutable Step inputs', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0078_agent_approval_intents.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0078 Agent approval intent migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /add column if not exists intent jsonb/i);
  assert.match(sql, /add column if not exists intent_hash text/i);
  assert.match(sql, /canonical_agent_approval_json/i);
  assert.match(sql, /hash_agent_approval_json/i);
  assert.match(sql, /status = 'expired'[\s\S]*immutable approval intent upgrade/i);
  assert.match(sql, /set status = 'queued', available_at = now\(\)/i);
  assert.match(sql, /checkpoint\.payload #>> '\{pending,approvalId\}' = approval\.id::text/i);
  assert.match(sql, /agent_approvals_intent_shape_check/i);
  assert.match(sql, /agent_approvals_intent_hash_check/i);
  assert.match(sql, /agent_approvals_intent_immutable_check/i);
  assert.match(sql, /agent_approval_step_binding_immutable_check/i);
  assert.match(sql, /before update of tool_key, input on agent_steps/i);
  assert.match(sql, /old\.status = 'pending' and new\.status = 'approved'/i);
  assert.match(sql, /canonical_tool_key is distinct from new\.intent ->> 'tool_key'/i);
  assert.match(sql, /hash_agent_approval_json\(canonical_input\)/i);
  assert.match(sql, /before insert or update on agent_approvals/i);
  assert.match(sql, /agent_approvals_user_pending_inbox_idx/i);

  const repository = readFileSync(
    path.join(serverRoot, 'src', 'repositories', 'agentRuns.ts'),
    'utf8',
  );
  assert.match(repository, /listAgentApprovalInboxForUser/);
  assert.match(repository, /expireStaleAgentApprovalsForUser/);
  assert.match(repository, /approval\.user_id = \$1/);
  assert.match(repository, /requester\.root_run_id = root\.root_run_id/);
  assert.match(repository, /\(approval\.created_at, approval\.id\) < \(\$/);
  assert.match(repository, /order by approval\.created_at desc, approval\.id desc/i);

  const controller = readFileSync(
    path.join(serverRoot, 'src', 'modules', 'agents', 'agent-runs.controller.ts'),
    'utf8',
  );
  assert.ok(
    controller.indexOf("@Get('approvals/inbox')") < controller.indexOf("@Get(':runId')"),
    'the literal Approval Inbox route must precede the generic Run route',
  );
});

test('Agent Memory embedding migration creates durable content-free fenced backfill jobs', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0079_agent_memory_embedding_jobs.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0079 Agent Memory embedding migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  const tableDefinition = sql.match(
    /create table if not exists agent_memory_embedding_jobs \(([\s\S]*?)\n\);/i,
  )?.[1] || '';

  assert.match(sql, /create table if not exists agent_memory_embedding_jobs/i);
  assert.match(sql, /where \(embedding is null\) <> \(embedding_model is null\)/i);
  assert.match(sql, /agent_memories_embedding_pair_check/i);
  assert.match(sql, /foreign key \(memory_id, user_id\)[\s\S]*on delete cascade/i);
  assert.match(sql, /status in \('queued', 'running', 'completed', 'failed', 'cancelled'\)/i);
  assert.match(sql, /agent_memory_embedding_jobs_lease_check/i);
  assert.match(sql, /agent_memory_embedding_jobs_terminal_check/i);
  assert.doesNotMatch(tableDefinition, /\bcontent\b/i, 'job rows must not duplicate Memory content');
  assert.match(sql, /new\.status <> 'confirmed'/i);
  assert.match(sql, /after insert or update of status, deleted_at, superseded_by, expires_at, embedding, embedding_model/i);
  assert.match(sql, /if not new\.enabled then[\s\S]*status = 'cancelled'/i);
  assert.match(sql, /memory\.status = 'confirmed'[\s\S]*memory\.embedding is null/i);
  assert.match(sql, /not exists \([\s\S]*agent_memory_scope_settings[\s\S]*not setting\.enabled/i);

  const repository = readFileSync(
    path.join(serverRoot, 'src', 'repositories', 'agentMemoryEmbeddings.ts'),
    'utf8',
  );
  assert.match(
    repository,
    /failAgentMemoryEmbeddingAttempt[\s\S]*lease_token = \$4[\s\S]*lease_expires_at > now\(\)/i,
  );
  assert.match(
    repository,
    /completeAgentMemoryEmbeddingJob[\s\S]*memory\.status = 'confirmed'[\s\S]*memory\.deleted_at is null[\s\S]*not setting\.enabled/i,
  );
  assert.match(
    repository,
    /reconcileInactiveAgentMemoryEmbeddingJobs[\s\S]*status = 'cancelled'[\s\S]*memory\.expires_at <= now\(\)/i,
  );
});

test('Agent conversation summaries use owned exact watermarks and serialized erasure', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0080_agent_conversation_summaries.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0080 Agent conversation summary migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /create table if not exists agent_conversation_summaries/i);
  assert.match(sql, /foreign key \(conversation_id, user_id\)[\s\S]*on delete cascade/i);
  assert.match(sql, /max_tokens between 32 and 4000/i);
  assert.match(sql, /candidate_message_count >= included_message_count/i);
  assert.match(sql, /if not found then[\s\S]*watermark message does not exist/i);
  assert.match(sql, /message_row\.conversation_id <> new\.conversation_id/i);
  assert.match(sql, /errcode = '23514'/i);
  assert.match(sql, /before delete on messages[\s\S]*lock_agent_conversation_summary_for_message/i);
  assert.match(sql, /before update of content, role on messages[\s\S]*lock_agent_conversation_summary_for_message/i);
  assert.match(sql, /after delete on messages[\s\S]*invalidate_agent_conversation_summary_for_message/i);
  assert.match(sql, /after update of content, role on messages[\s\S]*invalidate_agent_conversation_summary_for_message/i);
  assert.match(sql, /\(old\.created_at, old\.id\)[\s\S]*<= \(summary_row\.watermark_created_at, summary_row\.watermark_message_id\)/i);
});

test('Agent tool Secret lifecycle migration creates content-free append-only audit evidence', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0081_agent_tool_secret_lifecycle.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0081 Agent tool Secret lifecycle migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  assert.match(sql, /create table if not exists agent_tool_secret_events/i);
  assert.match(sql, /event_type in \('configured', 'replaced', 'cleared', 'used', 'decrypt_failed', 'rewrapped'\)/i);
  assert.match(sql, /envelope_version is null or envelope_version in \(1, 2\)/i);
  assert.match(sql, /before update or delete on agent_tool_secret_events/i);
  assert.match(sql, /tg_op = 'DELETE'[\s\S]*not exists[\s\S]*from users where id = old\.user_id/i);
  assert.match(sql, /Agent tool Secret events are append-only/i);
  assert.doesNotMatch(sql, /secret_(?:name|key|value)|plaintext/i);
});

test('Agent tool diagnostic history is version-pinned, payload-free and transactionally bounded', () => {
  const migrationPath = path.join(
    serverRoot,
    'migrations',
    '0082_agent_tool_diagnostic_history.sql',
  );
  assert.equal(existsSync(migrationPath), true, '0082 Agent tool diagnostic history migration is missing');
  const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
  const repositoryPath = path.join(
    serverRoot,
    'src',
    'repositories',
    'agentToolDiagnostics.ts',
  );
  const repository = readFileSync(repositoryPath, 'utf8');

  assert.match(sql, /create table if not exists agent_tool_diagnostics/i);
  assert.match(sql, /foreign key \(tool_id, user_id\)[\s\S]*references agent_tools\(id, user_id\)/i);
  assert.match(sql, /foreign key \(tool_version_id, tool_id, configuration_hash\)[\s\S]*references agent_tool_versions\(id, tool_id, configuration_hash\)/i);
  assert.match(sql, /operation in \('preflight', 'safe_test', 'discover'\)/i);
  assert.match(sql, /before update on agent_tool_diagnostics/i);
  assert.doesNotMatch(sql, /input_hash|response_(?:body|preview)|encrypted_secrets/i);
  assert.match(repository, /pg_advisory_xact_lock[\s\S]*agent-tool-diagnostic-history/i);
  assert.match(repository, /delete from agent_tool_diagnostics[\s\S]*offset \$2/i);
  assert.match(repository, /HISTORY_LIMIT_PER_TOOL = 200/);
  assert.match(repository, /order by checked_at desc, id desc[\s\S]*limit \$/i);
});

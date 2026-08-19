create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_space_id uuid references project_spaces(id) on delete set null,
  name text not null,
  description text not null default '',
  avatar text not null default '',
  visibility text not null default 'private',
  status text not null default 'draft',
  current_version_id uuid,
  published_version_id uuid,
  latest_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agents_visibility_check check (visibility in ('private', 'project')),
  constraint agents_status_check check (status in ('draft', 'published', 'disabled')),
  constraint agents_latest_version_check check (latest_version > 0)
);

create table if not exists agent_versions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  version integer not null,
  instructions text not null,
  model text not null,
  temperature double precision not null default 0.7,
  max_iterations smallint not null default 6,
  max_duration_ms integer not null default 120000,
  max_output_tokens integer not null default 4096,
  memory_mode text not null default 'conversation',
  response_format text not null default 'markdown',
  output_schema jsonb not null default '{}'::jsonb,
  approval_policy text not null default 'writes',
  tool_bindings jsonb not null default '[]'::jsonb,
  welcome_message text not null default '',
  suggested_prompts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_versions_agent_version_unique unique (agent_id, version),
  constraint agent_versions_version_check check (version > 0),
  constraint agent_versions_temperature_check check (temperature >= 0 and temperature <= 2),
  constraint agent_versions_max_iterations_check check (max_iterations between 1 and 20),
  constraint agent_versions_max_duration_check check (max_duration_ms between 1000 and 900000),
  constraint agent_versions_max_output_tokens_check check (max_output_tokens between 128 and 100000),
  constraint agent_versions_memory_mode_check check (memory_mode in ('none', 'conversation', 'user', 'project')),
  constraint agent_versions_response_format_check check (response_format in ('markdown', 'json')),
  constraint agent_versions_approval_policy_check check (approval_policy in ('never', 'writes', 'always')),
  constraint agent_versions_output_schema_object_check check (jsonb_typeof(output_schema) = 'object'),
  constraint agent_versions_tool_bindings_array_check check (jsonb_typeof(tool_bindings) = 'array'),
  constraint agent_versions_suggested_prompts_array_check check (jsonb_typeof(suggested_prompts) = 'array')
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agents_current_version_id_fkey'
      and conrelid = 'agents'::regclass
  ) then
    alter table agents
      add constraint agents_current_version_id_fkey
      foreign key (current_version_id) references agent_versions(id) on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'agents_published_version_id_fkey'
      and conrelid = 'agents'::regclass
  ) then
    alter table agents
      add constraint agents_published_version_id_fkey
      foreign key (published_version_id) references agent_versions(id) on delete set null;
  end if;
end $$;

create table if not exists agent_tools (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_space_id uuid references project_spaces(id) on delete set null,
  name text not null,
  description text not null default '',
  kind text not null,
  risk_level text not null default 'read',
  configuration jsonb not null default '{}'::jsonb,
  encrypted_secrets text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_tools_kind_check check (kind in ('http', 'mcp')),
  constraint agent_tools_risk_level_check check (risk_level in ('read', 'write', 'high')),
  constraint agent_tools_configuration_object_check check (jsonb_typeof(configuration) = 'object')
);

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  agent_version_id uuid references agent_versions(id) on delete set null,
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_message_id uuid references messages(id) on delete set null,
  assistant_message_id uuid references messages(id) on delete set null,
  status text not null default 'queued',
  iteration_count smallint not null default 0,
  tool_call_count smallint not null default 0,
  token_usage jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_runs_status_check check (status in ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  constraint agent_runs_iteration_count_check check (iteration_count >= 0),
  constraint agent_runs_tool_call_count_check check (tool_call_count >= 0),
  constraint agent_runs_token_usage_object_check check (jsonb_typeof(token_usage) = 'object')
);

create table if not exists agent_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs(id) on delete cascade,
  sequence integer not null,
  kind text not null,
  status text not null,
  tool_call_id text,
  tool_key text,
  input jsonb,
  output jsonb,
  content text,
  duration_ms integer,
  created_at timestamptz not null default now(),
  constraint agent_steps_run_sequence_unique unique (run_id, sequence),
  constraint agent_steps_sequence_check check (sequence >= 0),
  constraint agent_steps_kind_check check (kind in ('model', 'tool_call', 'tool_result', 'approval', 'assistant')),
  constraint agent_steps_status_check check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'rejected')),
  constraint agent_steps_duration_check check (duration_ms is null or duration_ms >= 0)
);

create table if not exists agent_approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs(id) on delete cascade,
  step_id uuid references agent_steps(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null default 'pending',
  reason text not null default '',
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_approvals_status_check check (status in ('pending', 'approved', 'rejected', 'expired'))
);

alter table conversations
  add column if not exists agent_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'conversations_agent_id_fkey'
      and conrelid = 'conversations'::regclass
  ) then
    alter table conversations
      add constraint conversations_agent_id_fkey
      foreign key (agent_id) references agents(id) on delete set null;
  end if;
end $$;

create index if not exists agents_user_project_status_updated_idx
  on agents (user_id, project_space_id, status, updated_at desc);
create index if not exists agents_user_updated_idx
  on agents (user_id, updated_at desc);
create index if not exists agents_current_version_id_idx
  on agents (current_version_id);
create index if not exists agents_published_version_id_idx
  on agents (published_version_id);
create unique index if not exists agents_user_name_lower_unique_idx
  on agents (user_id, lower(name));

create index if not exists agent_versions_agent_version_idx
  on agent_versions (agent_id, version desc);

create index if not exists agent_tools_user_project_updated_idx
  on agent_tools (user_id, project_space_id, updated_at desc);
create unique index if not exists agent_tools_user_name_lower_unique_idx
  on agent_tools (user_id, lower(name));

create index if not exists agent_runs_user_created_idx
  on agent_runs (user_id, created_at desc);
create index if not exists agent_runs_conversation_created_idx
  on agent_runs (conversation_id, created_at desc);
create index if not exists agent_runs_agent_created_idx
  on agent_runs (agent_id, created_at desc);
create index if not exists agent_runs_user_message_id_idx
  on agent_runs (user_message_id)
  where user_message_id is not null;
create index if not exists agent_runs_assistant_message_created_idx
  on agent_runs (assistant_message_id, created_at desc)
  where assistant_message_id is not null;
create index if not exists agent_runs_active_idx
  on agent_runs (status, created_at)
  where status in ('queued', 'running', 'waiting_approval');

create index if not exists agent_steps_run_sequence_idx
  on agent_steps (run_id, sequence);
create index if not exists agent_approvals_run_status_idx
  on agent_approvals (run_id, status, created_at);
create index if not exists agent_approvals_step_id_idx
  on agent_approvals (step_id)
  where step_id is not null;
create index if not exists agent_approvals_user_pending_idx
  on agent_approvals (user_id, created_at desc)
  where status = 'pending';
create index if not exists conversations_agent_id_updated_idx
  on conversations (agent_id, updated_at desc)
  where agent_id is not null;

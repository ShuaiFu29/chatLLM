-- Draft Agent previews are intentionally separate from production agent_runs.
-- They call the pinned model configuration, but never create a conversation,
-- approval, Memory write, subagent, tool invocation, or production Run tree.

create table if not exists agent_version_dry_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  agent_version_id uuid not null,
  status text not null default 'running',
  input_text text not null,
  output_text text not null default '',
  validation_report jsonb not null,
  planned_tool_calls jsonb not null default '[]'::jsonb,
  usage jsonb not null default '{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}'::jsonb,
  isolation_report jsonb not null,
  failure_code text,
  failure_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint agent_version_dry_runs_version_agent_fkey
    foreign key (agent_version_id, agent_id)
    references agent_versions(id, agent_id)
    on delete cascade,
  constraint agent_version_dry_runs_status_check
    check (status in ('running', 'succeeded', 'failed')),
  constraint agent_version_dry_runs_input_check
    check (char_length(input_text) between 1 and 16000),
  constraint agent_version_dry_runs_output_check
    check (octet_length(output_text) <= 1048576),
  constraint agent_version_dry_runs_validation_report_check
    check (
      jsonb_typeof(validation_report) = 'object'
      and jsonb_typeof(validation_report -> 'checks') = 'array'
      and octet_length(validation_report::text) <= 262144
    ),
  constraint agent_version_dry_runs_tool_calls_check
    check (
      jsonb_typeof(planned_tool_calls) = 'array'
      and jsonb_array_length(planned_tool_calls) <= 24
      and octet_length(planned_tool_calls::text) <= 262144
    ),
  constraint agent_version_dry_runs_usage_check
    check (
      jsonb_typeof(usage) = 'object'
      and jsonb_typeof(usage -> 'prompt_tokens') = 'number'
      and jsonb_typeof(usage -> 'completion_tokens') = 'number'
      and jsonb_typeof(usage -> 'total_tokens') = 'number'
      and usage ->> 'prompt_tokens' ~ '^[0-9]+$'
      and usage ->> 'completion_tokens' ~ '^[0-9]+$'
      and usage ->> 'total_tokens' ~ '^[0-9]+$'
      and (usage ->> 'prompt_tokens')::bigint >= 0
      and (usage ->> 'completion_tokens')::bigint >= 0
      and (usage ->> 'total_tokens')::bigint >= 0
      and (usage ->> 'prompt_tokens')::bigint
        + (usage ->> 'completion_tokens')::bigint
        <= (usage ->> 'total_tokens')::bigint
    ),
  constraint agent_version_dry_runs_isolation_report_check
    check (
      jsonb_typeof(isolation_report) = 'object'
      and isolation_report ->> 'mode' = 'model_only'
      and jsonb_typeof(isolation_report -> 'blocked_effects') = 'array'
      and jsonb_typeof(isolation_report -> 'omitted_context') = 'array'
      and octet_length(isolation_report::text) <= 65536
    ),
  constraint agent_version_dry_runs_terminal_check
    check (
      (
        status = 'running'
        and completed_at is null
        and failure_code is null
        and failure_message is null
      )
      or (
        status = 'succeeded'
        and completed_at is not null
        and failure_code is null
        and failure_message is null
      )
      or (
        status = 'failed'
        and completed_at is not null
        and failure_code is not null
        and failure_message is not null
      )
    ),
  constraint agent_version_dry_runs_failure_code_check
    check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint agent_version_dry_runs_failure_message_check
    check (failure_message is null or char_length(failure_message) between 1 and 1000)
);

create index if not exists agent_version_dry_runs_user_created_idx
  on agent_version_dry_runs(user_id, created_at desc, id desc);

create index if not exists agent_version_dry_runs_version_created_idx
  on agent_version_dry_runs(agent_version_id, created_at desc, id desc);

create index if not exists agent_version_dry_runs_running_idx
  on agent_version_dry_runs(user_id, created_at)
  where status = 'running';

comment on table agent_version_dry_runs is
  'Isolated model-only previews pinned to immutable Agent versions. Tool calls are validated and recorded but never executed.';

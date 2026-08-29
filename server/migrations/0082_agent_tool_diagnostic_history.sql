-- Bounded operational health history for immutable custom-tool versions.
-- Request arguments and remote response payloads are deliberately absent;
-- the append-only security evidence remains in agent_audit_events.

create unique index if not exists agent_tools_id_user_unique_idx
  on agent_tools(id, user_id);
create unique index if not exists agent_tool_versions_id_tool_hash_unique_idx
  on agent_tool_versions(id, tool_id, configuration_hash);

create table if not exists agent_tool_diagnostics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  tool_id uuid not null,
  tool_version_id uuid not null,
  configuration_hash text not null,
  operation text not null,
  status text not null,
  live_request_attempted boolean not null default false,
  passed_check_count smallint not null default 0,
  warning_check_count smallint not null default 0,
  failed_check_count smallint not null default 0,
  error_code text,
  response_status smallint,
  discovery_tool_count smallint,
  discovery_warning_count smallint,
  duration_ms integer not null,
  checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint agent_tool_diagnostics_tool_owner_fkey
    foreign key (tool_id, user_id)
    references agent_tools(id, user_id)
    on delete cascade,
  constraint agent_tool_diagnostics_version_fingerprint_fkey
    foreign key (tool_version_id, tool_id, configuration_hash)
    references agent_tool_versions(id, tool_id, configuration_hash)
    on delete cascade,
  constraint agent_tool_diagnostics_operation_check check (
    operation in ('preflight', 'safe_test', 'discover')
  ),
  constraint agent_tool_diagnostics_status_check check (
    status in ('passed', 'failed')
  ),
  constraint agent_tool_diagnostics_configuration_hash_check check (
    configuration_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint agent_tool_diagnostics_check_counts_check check (
    passed_check_count between 0 and 20
    and warning_check_count between 0 and 20
    and failed_check_count between 0 and 20
    and passed_check_count + warning_check_count + failed_check_count between 1 and 20
  ),
  constraint agent_tool_diagnostics_error_code_check check (
    (status = 'passed' and error_code is null)
    or (
      status = 'failed'
      and error_code ~ '^[a-z0-9_]{1,100}$'
    )
  ),
  constraint agent_tool_diagnostics_response_status_check check (
    response_status is null or response_status between 100 and 599
  ),
  constraint agent_tool_diagnostics_discovery_counts_check check (
    (discovery_tool_count is null or discovery_tool_count between 0 and 200)
    and (discovery_warning_count is null or discovery_warning_count between 0 and 20)
  ),
  constraint agent_tool_diagnostics_duration_check check (
    duration_ms between 0 and 120000
  )
);

create index if not exists agent_tool_diagnostics_tool_checked_idx
  on agent_tool_diagnostics(user_id, tool_id, checked_at desc, id desc);
create index if not exists agent_tool_diagnostics_version_checked_idx
  on agent_tool_diagnostics(tool_version_id, checked_at desc, id desc);

create or replace function reject_agent_tool_diagnostic_update()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = '23514',
    constraint = 'agent_tool_diagnostics_immutable_check',
    message = 'Agent tool diagnostic history is immutable';
end;
$$;

drop trigger if exists agent_tool_diagnostics_immutable_trigger
  on agent_tool_diagnostics;
create trigger agent_tool_diagnostics_immutable_trigger
before update on agent_tool_diagnostics
for each row execute function reject_agent_tool_diagnostic_update();

comment on table agent_tool_diagnostics is
  'Bounded payload-free operational health history for immutable custom-tool versions; repositories retain the newest 200 rows per tool.';

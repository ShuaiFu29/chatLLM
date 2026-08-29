-- Pin every custom Agent tool binding to an immutable executable version.
-- The legacy executable columns on agent_tools remain as migration mirrors for
-- one compatibility window; current_version_id is the new source of truth.

alter table agent_tools
  add column if not exists current_version_id uuid;
alter table agent_tools
  add column if not exists latest_version integer not null default 1;
alter table agent_tools
  add column if not exists deleted_at timestamptz;

alter table agent_tools
  drop constraint if exists agent_tools_latest_version_check;
alter table agent_tools
  add constraint agent_tools_latest_version_check check (latest_version > 0);

create table if not exists agent_tool_versions (
  id uuid primary key default gen_random_uuid(),
  tool_id uuid not null references agent_tools(id) on delete cascade,
  version integer not null,
  description text not null default '',
  kind text not null,
  risk_level text not null default 'read',
  max_invocations_per_run smallint,
  configuration jsonb not null default '{}'::jsonb,
  encrypted_secrets text,
  secret_version integer not null default 1,
  configuration_hash text,
  derived_from_version_id uuid,
  change_kind text not null default 'edited',
  created_at timestamptz not null default now(),
  constraint agent_tool_versions_tool_version_unique unique (tool_id, version),
  constraint agent_tool_versions_version_check check (version > 0),
  constraint agent_tool_versions_kind_check check (kind in ('http', 'mcp')),
  constraint agent_tool_versions_risk_level_check check (risk_level in ('read', 'write', 'high')),
  constraint agent_tool_versions_max_invocations_check check (
    max_invocations_per_run is null or max_invocations_per_run between 1 and 100
  ),
  constraint agent_tool_versions_configuration_object_check check (
    jsonb_typeof(configuration) = 'object'
  ),
  constraint agent_tool_versions_secret_version_check check (secret_version > 0),
  constraint agent_tool_versions_change_kind_check check (
    change_kind in ('created', 'edited', 'secret_rotated')
  )
);

create unique index if not exists agent_tool_versions_id_tool_unique_idx
  on agent_tool_versions(id, tool_id);
create index if not exists agent_tool_versions_tool_version_idx
  on agent_tool_versions(tool_id, version desc);

create or replace function compute_agent_tool_version_configuration_hash(
  version_row agent_tool_versions
)
returns text
language sql
immutable
strict
as $$
  select encode(
    digest(
      convert_to(
        jsonb_build_object(
          'format_version', 1,
          'description', version_row.description,
          'kind', version_row.kind,
          'risk_level', version_row.risk_level,
          'max_invocations_per_run', version_row.max_invocations_per_run,
          'configuration', version_row.configuration,
          'secret_version', version_row.secret_version,
          'secret_ciphertext_hash', encode(
            digest(coalesce(version_row.encrypted_secrets, ''), 'sha256'),
            'hex'
          )
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

create or replace function set_agent_tool_version_configuration_hash()
returns trigger
language plpgsql
as $$
begin
  new.configuration_hash := compute_agent_tool_version_configuration_hash(new);
  return new;
end;
$$;

drop trigger if exists agent_tool_versions_configuration_hash_trigger on agent_tool_versions;
create trigger agent_tool_versions_configuration_hash_trigger
before insert on agent_tool_versions
for each row execute function set_agent_tool_version_configuration_hash();

insert into agent_tool_versions (
  tool_id, version, description, kind, risk_level, max_invocations_per_run,
  configuration, encrypted_secrets, secret_version, change_kind, created_at
)
select
  tool.id, 1, tool.description, tool.kind, tool.risk_level,
  tool.max_invocations_per_run, tool.configuration, tool.encrypted_secrets,
  1, 'created', tool.created_at
from agent_tools tool
where not exists (
  select 1 from agent_tool_versions version where version.tool_id = tool.id
);

with latest_version as (
  select distinct on (candidate.tool_id)
    candidate.tool_id,
    candidate.id,
    candidate.version
  from agent_tool_versions candidate
  order by candidate.tool_id, candidate.version desc
)
update agent_tools tool
set current_version_id = latest_version.id,
    latest_version = greatest(tool.latest_version, latest_version.version)
from latest_version
where latest_version.tool_id = tool.id
  and tool.current_version_id is null;

alter table agent_tool_versions
  alter column configuration_hash set not null;
alter table agent_tool_versions
  drop constraint if exists agent_tool_versions_configuration_hash_check;
alter table agent_tool_versions
  add constraint agent_tool_versions_configuration_hash_check
  check (configuration_hash ~ '^[0-9a-f]{64}$');

alter table agent_tool_versions
  drop constraint if exists agent_tool_versions_derived_from_same_tool_fkey;
alter table agent_tool_versions
  add constraint agent_tool_versions_derived_from_same_tool_fkey
  foreign key (derived_from_version_id, tool_id)
  references agent_tool_versions(id, tool_id)
  deferrable initially deferred;

alter table agent_tools
  alter column current_version_id set not null;
alter table agent_tools
  drop constraint if exists agent_tools_current_version_same_tool_fkey;
alter table agent_tools
  add constraint agent_tools_current_version_same_tool_fkey
  foreign key (current_version_id, id)
  references agent_tool_versions(id, tool_id)
  deferrable initially deferred;

create or replace function reject_agent_tool_version_update()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = '23514',
    constraint = 'agent_tool_versions_immutable_check',
    message = 'Agent tool versions are immutable; create a new version instead';
end;
$$;

drop trigger if exists agent_tool_versions_immutable_trigger on agent_tool_versions;
create trigger agent_tool_versions_immutable_trigger
before update on agent_tool_versions
for each row execute function reject_agent_tool_version_update();

-- Agent versions are immutable after 0070, so temporarily remove their guards
-- while old custom bindings are pinned to the only executable version that
-- existed at migration time.
drop trigger if exists agent_versions_immutable_trigger on agent_versions;
drop trigger if exists agent_versions_configuration_hash_trigger on agent_versions;

update agent_versions version_row
set tool_bindings = (
  select coalesce(
    jsonb_agg(
      case
        when binding.value ->> 'key' like 'custom:%'
             and not (binding.value ? 'tool_version_id')
             and tool.current_version_id is not null
          then binding.value || jsonb_build_object('tool_version_id', tool.current_version_id)
        when binding.value ->> 'key' like 'custom:%'
             and not (binding.value ? 'tool_version_id')
          then binding.value || jsonb_build_object(
            'enabled', false,
            'legacy_unavailable', true
          )
        else binding.value
      end
      order by binding.ordinality
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(version_row.tool_bindings) with ordinality binding(value, ordinality)
  left join agent_tools tool
    on binding.value ->> 'key' = 'custom:' || tool.id::text
)
where exists (
  select 1
  from jsonb_array_elements(version_row.tool_bindings) binding(value)
  where binding.value ->> 'key' like 'custom:%'
    and not (binding.value ? 'tool_version_id')
);

create or replace function valid_versioned_agent_tool_bindings(bindings jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  binding jsonb;
  binding_key text;
  seen_keys text[] := array[]::text[];
begin
  if jsonb_typeof(bindings) <> 'array' or jsonb_array_length(bindings) > 24 then
    return false;
  end if;
  for binding in select value from jsonb_array_elements(bindings) loop
    if jsonb_typeof(binding) <> 'object'
       or jsonb_typeof(binding -> 'key') <> 'string'
       or coalesce(binding ->> 'key', '') = ''
       or jsonb_typeof(binding -> 'enabled') <> 'boolean'
       or (binding ? 'configuration' and jsonb_typeof(binding -> 'configuration') <> 'object') then
      return false;
    end if;
    binding_key := binding ->> 'key';
    if binding_key = any(seen_keys) then
      return false;
    end if;
    seen_keys := array_append(seen_keys, binding_key);

    if binding_key ~* '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      if binding ? 'tool_version_id' then
        if jsonb_typeof(binding -> 'tool_version_id') <> 'string'
           or not ((binding ->> 'tool_version_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
           or binding ? 'legacy_unavailable' then
          return false;
        end if;
      elsif not (
        coalesce((binding ->> 'enabled')::boolean, true) = false
        and binding ->> 'legacy_unavailable' = 'true'
      ) then
        return false;
      end if;
    elsif binding ? 'tool_version_id' or binding ? 'legacy_unavailable' then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

alter table agent_versions
  drop constraint if exists agent_versions_tool_bindings_array_check;
alter table agent_versions
  drop constraint if exists agent_versions_tool_bindings_versioned_check;
alter table agent_versions
  add constraint agent_versions_tool_bindings_versioned_check
  check (valid_versioned_agent_tool_bindings(tool_bindings));

create or replace function compute_agent_version_configuration_hash(version_row agent_versions)
returns text
language sql
immutable
strict
as $$
  select encode(
    digest(
      convert_to(
        jsonb_build_object(
          'format_version', 3,
          'instructions', version_row.instructions,
          'model', version_row.model,
          'temperature', version_row.temperature,
          'max_iterations', version_row.max_iterations,
          'max_duration_ms', version_row.max_duration_ms,
          'max_output_tokens', version_row.max_output_tokens,
          'memory_mode', version_row.memory_mode,
          'memory_policy', version_row.memory_policy,
          'response_format', version_row.response_format,
          'output_schema', version_row.output_schema,
          'approval_policy', version_row.approval_policy,
          'tool_bindings', version_row.tool_bindings,
          'welcome_message', version_row.welcome_message,
          'suggested_prompts', version_row.suggested_prompts
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

update agent_versions version_row
set configuration_hash = compute_agent_version_configuration_hash(version_row);

create trigger agent_versions_configuration_hash_trigger
before insert on agent_versions
for each row execute function set_agent_version_configuration_hash();

create trigger agent_versions_immutable_trigger
before update on agent_versions
for each row execute function reject_agent_version_update();

drop index if exists agent_tools_user_name_lower_unique_idx;
create unique index if not exists agent_tools_user_name_lower_active_unique_idx
  on agent_tools(user_id, lower(name))
  where deleted_at is null;

comment on table agent_tool_versions is
  'Append-only executable custom-tool definitions. Agent bindings and Runs pin ids from this table.';
comment on column agent_tool_versions.secret_version is
  'Monotonic credential revision. It changes only when encrypted secrets are replaced or cleared.';
comment on column agent_tool_versions.configuration_hash is
  'SHA-256 of the executable definition, retry inputs and credential revision/ciphertext digest.';
comment on column agent_tools.current_version_id is
  'Current definition for future bindings. Existing Agent versions remain pinned to their tool_version_id.';
comment on column agent_tools.deleted_at is
  'Soft deletion marker; immutable tool versions remain for historical Runs and audit.';

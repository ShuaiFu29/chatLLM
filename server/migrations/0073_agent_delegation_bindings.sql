-- Replace model-selected raw Agent UUIDs with a versioned collaborator catalog.
-- Existing published versions retain their old dynamic semantics only through
-- an explicit compatibility mode; all newly created versions use pinned aliases.

alter table agent_versions
  add column if not exists delegation_mode text not null default 'explicit';
alter table agent_versions
  add column if not exists delegation_bindings jsonb not null default '[]'::jsonb;

-- The governance migrations make version rows append-only. This migration has
-- to classify legacy rows and recompute their fingerprint, so temporarily
-- remove both write guards before the first backfill update.
drop trigger if exists agent_versions_immutable_trigger on agent_versions;
drop trigger if exists agent_versions_configuration_hash_trigger on agent_versions;

update agent_versions version_row
set delegation_mode = 'legacy_dynamic'
where version_row.delegation_mode = 'explicit'
  and version_row.delegation_bindings = '[]'::jsonb
  and exists (
    select 1
    from jsonb_array_elements(version_row.tool_bindings) binding(value)
    where binding.value ->> 'key' = 'dispatch_subagents'
      and coalesce((binding.value ->> 'enabled')::boolean, true)
  );

create or replace function valid_agent_delegation_bindings(bindings jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  binding jsonb;
  alias_value text;
  context_key text;
  seen_aliases text[] := array[]::text[];
  seen_context_keys text[];
begin
  if jsonb_typeof(bindings) <> 'array' or jsonb_array_length(bindings) > 16 then
    return false;
  end if;
  for binding in select value from jsonb_array_elements(bindings) loop
    if jsonb_typeof(binding) <> 'object'
       or binding - array[
         'alias', 'agent_id', 'version_policy', 'agent_version_id', 'role',
         'max_parallelism', 'allowed_context_keys'
       ]::text[] <> '{}'::jsonb
       or coalesce(jsonb_typeof(binding -> 'alias'), '') <> 'string'
       or coalesce(binding ->> 'alias', '') !~ '^[a-z][a-z0-9_]{0,31}$'
       or coalesce(jsonb_typeof(binding -> 'agent_id'), '') <> 'string'
       or coalesce(binding ->> 'agent_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(binding ->> 'version_policy', '') <> 'pinned'
       or coalesce(jsonb_typeof(binding -> 'agent_version_id'), '') <> 'string'
       or coalesce(binding ->> 'agent_version_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(jsonb_typeof(binding -> 'role'), '') <> 'string'
       or length(coalesce(binding ->> 'role', '')) > 500
       or coalesce(binding ->> 'role', '') !~ '[^[:space:]]'
       or coalesce(jsonb_typeof(binding -> 'max_parallelism'), '') <> 'number'
       or coalesce(jsonb_typeof(binding -> 'allowed_context_keys'), '') <> 'array'
       or jsonb_array_length(binding -> 'allowed_context_keys') > 16 then
      return false;
    end if;
    if (binding ->> 'max_parallelism')::numeric <> trunc((binding ->> 'max_parallelism')::numeric)
       or (binding ->> 'max_parallelism')::integer not between 1 and 16 then
      return false;
    end if;

    alias_value := binding ->> 'alias';
    if alias_value = any(seen_aliases) then
      return false;
    end if;
    seen_aliases := array_append(seen_aliases, alias_value);

    seen_context_keys := array[]::text[];
    for context_key in
      select value from jsonb_array_elements_text(binding -> 'allowed_context_keys')
    loop
      if context_key !~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'
         or context_key = any(seen_context_keys) then
        return false;
      end if;
      seen_context_keys := array_append(seen_context_keys, context_key);
    end loop;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function valid_agent_delegation_configuration(
  tool_bindings jsonb,
  delegation_mode text,
  delegation_bindings jsonb
)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  dispatch_enabled boolean;
begin
  if delegation_mode not in ('explicit', 'legacy_dynamic')
     or not valid_agent_delegation_bindings(delegation_bindings) then
    return false;
  end if;
  select exists (
    select 1
    from jsonb_array_elements(tool_bindings) binding(value)
    where binding.value ->> 'key' = 'dispatch_subagents'
      and coalesce((binding.value ->> 'enabled')::boolean, true)
  ) into dispatch_enabled;

  if delegation_mode = 'legacy_dynamic' then
    return dispatch_enabled and delegation_bindings = '[]'::jsonb;
  end if;
  return (
    dispatch_enabled
    and jsonb_array_length(delegation_bindings) > 0
  ) or (
    not dispatch_enabled
    and jsonb_array_length(delegation_bindings) = 0
  );
exception when others then
  return false;
end;
$$;

alter table agent_versions
  drop constraint if exists agent_versions_delegation_configuration_check;
alter table agent_versions
  add constraint agent_versions_delegation_configuration_check check (
    valid_agent_delegation_configuration(
      tool_bindings,
      delegation_mode,
      delegation_bindings
    )
  );

-- Recompute immutable Agent fingerprints with the collaborator directory.
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
          'format_version', 4,
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
          'delegation_mode', version_row.delegation_mode,
          'delegation_bindings', version_row.delegation_bindings,
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

comment on column agent_versions.delegation_mode is
  'explicit for pinned collaborator aliases; legacy_dynamic is migration-only compatibility.';
comment on column agent_versions.delegation_bindings is
  'Versioned collaborator catalog with pinned Agent version, role, concurrency and context allowlist.';

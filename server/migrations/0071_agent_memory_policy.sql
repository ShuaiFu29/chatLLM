-- Replace the legacy four-way memory switch with an immutable, versioned policy.
-- memory_mode remains as a compatibility projection for existing clients.

alter table agent_versions
  add column if not exists memory_policy jsonb;

drop trigger if exists agent_versions_immutable_trigger on agent_versions;
drop trigger if exists agent_versions_configuration_hash_trigger on agent_versions;

create or replace function legacy_agent_memory_policy(mode_value text)
returns jsonb
language sql
immutable
strict
as $$
  select jsonb_build_object(
    'format_version', 1,
    'conversation', jsonb_build_object(
      'enabled', mode_value <> 'none',
      'message_limit', case when mode_value = 'none' then 0 else 20 end,
      'rolling_summary', jsonb_build_object('enabled', false, 'max_tokens', 0)
    ),
    'persona', jsonb_build_object('enabled', mode_value = 'user'),
    'project_context', jsonb_build_object('enabled', mode_value = 'project'),
    'read', jsonb_build_object(
      'allowed_scopes', jsonb_build_array('user', 'project', 'agent'),
      'auto_recall', mode_value in ('user', 'project'),
      'auto_scopes', case
        when mode_value = 'user' then jsonb_build_array('user', 'agent')
        when mode_value = 'project' then jsonb_build_array('project', 'agent')
        else '[]'::jsonb
      end,
      'top_k', 20,
      'token_budget', 1000,
      'min_trust', 'tool_derived'
    ),
    'write', jsonb_build_object(
      'enabled', true,
      'allowed_scopes', jsonb_build_array('user', 'project', 'agent'),
      'default_ttl_days', null,
      'require_confirmation', true
    ),
    'subagent', jsonb_build_object(
      'share_recalled_memory', false,
      'max_items', 0,
      'token_budget', 0
    )
  )
$$;

create or replace function project_agent_memory_mode(policy_value jsonb)
returns text
language sql
immutable
strict
as $$
  select coalesce(
    (
      select mode_value
      from unnest(array['none', 'conversation', 'user', 'project']) mode_value
      where policy_value = legacy_agent_memory_policy(mode_value)
      limit 1
    ),
    'custom'
  )
$$;

create or replace function jsonb_object_has_exact_keys(value jsonb, expected text[])
returns boolean
language sql
immutable
strict
as $$
  select jsonb_typeof(value) = 'object'
    and (select array_agg(key order by key) from jsonb_object_keys(value) key)
      = (select array_agg(item order by item) from unnest(expected) item)
$$;

create or replace function valid_agent_memory_policy(policy_value jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  allowed_read text[];
  automatic_read text[];
  allowed_write text[];
begin
  if not jsonb_object_has_exact_keys(policy_value, array[
       'conversation', 'format_version', 'persona', 'project_context',
       'read', 'subagent', 'write'
     ]::text[])
     or policy_value ->> 'format_version' <> '1'
     or not jsonb_object_has_exact_keys(
       policy_value -> 'conversation',
       array['enabled', 'message_limit', 'rolling_summary']::text[]
     )
     or not jsonb_object_has_exact_keys(
       policy_value #> '{conversation,rolling_summary}',
       array['enabled', 'max_tokens']::text[]
     )
     or not jsonb_object_has_exact_keys(policy_value -> 'persona', array['enabled']::text[])
     or not jsonb_object_has_exact_keys(policy_value -> 'project_context', array['enabled']::text[])
     or not jsonb_object_has_exact_keys(
       policy_value -> 'read',
       array['allowed_scopes', 'auto_recall', 'auto_scopes', 'min_trust', 'token_budget', 'top_k']::text[]
     )
     or not jsonb_object_has_exact_keys(
       policy_value -> 'write',
       array['allowed_scopes', 'default_ttl_days', 'enabled', 'require_confirmation']::text[]
     )
     or not jsonb_object_has_exact_keys(
       policy_value -> 'subagent',
       array['max_items', 'share_recalled_memory', 'token_budget']::text[]
     ) then
    return false;
  end if;

  allowed_read := array(select jsonb_array_elements_text(policy_value #> '{read,allowed_scopes}'));
  automatic_read := array(select jsonb_array_elements_text(policy_value #> '{read,auto_scopes}'));
  allowed_write := array(select jsonb_array_elements_text(policy_value #> '{write,allowed_scopes}'));

  return
    jsonb_typeof(policy_value #> '{conversation,enabled}') = 'boolean'
    and jsonb_typeof(policy_value #> '{conversation,message_limit}') = 'number'
    and (policy_value #>> '{conversation,message_limit}')::integer between 0 and 100
    and (((policy_value #>> '{conversation,enabled}')::boolean
      and (policy_value #>> '{conversation,message_limit}')::integer > 0)
      or (not (policy_value #>> '{conversation,enabled}')::boolean
        and (policy_value #>> '{conversation,message_limit}')::integer = 0))
    and jsonb_typeof(policy_value #> '{conversation,rolling_summary,enabled}') = 'boolean'
    and jsonb_typeof(policy_value #> '{conversation,rolling_summary,max_tokens}') = 'number'
    and (policy_value #>> '{conversation,rolling_summary,max_tokens}')::integer between 0 and 4000
    and (((policy_value #>> '{conversation,rolling_summary,enabled}')::boolean
      and (policy_value #>> '{conversation,rolling_summary,max_tokens}')::integer > 0)
      or (not (policy_value #>> '{conversation,rolling_summary,enabled}')::boolean
        and (policy_value #>> '{conversation,rolling_summary,max_tokens}')::integer = 0))
    and jsonb_typeof(policy_value #> '{persona,enabled}') = 'boolean'
    and jsonb_typeof(policy_value #> '{project_context,enabled}') = 'boolean'
    and jsonb_typeof(policy_value #> '{read,allowed_scopes}') = 'array'
    and jsonb_typeof(policy_value #> '{read,auto_recall}') = 'boolean'
    and jsonb_typeof(policy_value #> '{read,auto_scopes}') = 'array'
    and cardinality(allowed_read) = cardinality(array(
      select distinct scope_value from unnest(allowed_read) as item(scope_value)
    ))
    and cardinality(automatic_read) = cardinality(array(
      select distinct scope_value from unnest(automatic_read) as item(scope_value)
    ))
    and allowed_read <@ array['user', 'project', 'agent']::text[]
    and automatic_read <@ allowed_read
    and (((policy_value #>> '{read,auto_recall}')::boolean
      and cardinality(automatic_read) > 0
      and (policy_value #>> '{read,token_budget}')::integer > 0)
      or (not (policy_value #>> '{read,auto_recall}')::boolean
        and cardinality(automatic_read) = 0))
    and (policy_value #>> '{read,top_k}')::integer between 1 and 20
    and (policy_value #>> '{read,token_budget}')::integer between 0 and 1000
    and policy_value #>> '{read,min_trust}' in ('user_stated', 'agent_inferred', 'tool_derived')
    and jsonb_typeof(policy_value #> '{write,enabled}') = 'boolean'
    and jsonb_typeof(policy_value #> '{write,allowed_scopes}') = 'array'
    and cardinality(allowed_write) = cardinality(array(
      select distinct scope_value from unnest(allowed_write) as item(scope_value)
    ))
    and allowed_write <@ array['user', 'project', 'agent']::text[]
    and (((policy_value #>> '{write,enabled}')::boolean and cardinality(allowed_write) > 0)
      or (not (policy_value #>> '{write,enabled}')::boolean and cardinality(allowed_write) = 0))
    and (
      policy_value #> '{write,default_ttl_days}' = 'null'::jsonb
      or (policy_value #>> '{write,default_ttl_days}')::integer between 1 and 365
    )
    and jsonb_typeof(policy_value #> '{write,require_confirmation}') = 'boolean'
    and jsonb_typeof(policy_value #> '{subagent,share_recalled_memory}') = 'boolean'
    and (policy_value #>> '{subagent,max_items}')::integer between 0 and 20
    and (policy_value #>> '{subagent,token_budget}')::integer between 0 and 1000
    and (((policy_value #>> '{subagent,share_recalled_memory}')::boolean
      and (policy_value #>> '{subagent,max_items}')::integer > 0
      and (policy_value #>> '{subagent,token_budget}')::integer > 0)
      or (not (policy_value #>> '{subagent,share_recalled_memory}')::boolean
        and (policy_value #>> '{subagent,max_items}')::integer = 0
        and (policy_value #>> '{subagent,token_budget}')::integer = 0));
exception when others then
  return false;
end;
$$;

update agent_versions
set memory_policy = legacy_agent_memory_policy(memory_mode)
where memory_policy is null;

alter table agent_versions
  alter column memory_policy set not null;
alter table agent_versions
  drop constraint if exists agent_versions_memory_mode_check;
alter table agent_versions
  add constraint agent_versions_memory_mode_check
  check (memory_mode in ('none', 'conversation', 'user', 'project', 'custom'));
alter table agent_versions
  drop constraint if exists agent_versions_memory_policy_check;
alter table agent_versions
  add constraint agent_versions_memory_policy_check
  check (valid_agent_memory_policy(memory_policy));

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
          'format_version', 2,
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

create or replace function set_agent_version_configuration_hash()
returns trigger
language plpgsql
as $$
begin
  if new.memory_policy is null then
    if new.memory_mode = 'custom' then
      raise exception using
        errcode = '23514',
        constraint = 'agent_versions_memory_policy_check',
        message = 'Custom memory mode requires a structured policy';
    end if;
    new.memory_policy := legacy_agent_memory_policy(new.memory_mode);
  end if;
  if not valid_agent_memory_policy(new.memory_policy) then
    raise exception using
      errcode = '23514',
      constraint = 'agent_versions_memory_policy_check',
      message = 'Agent memory policy is invalid';
  end if;
  new.memory_mode := project_agent_memory_mode(new.memory_policy);
  new.configuration_hash := compute_agent_version_configuration_hash(new);
  return new;
end;
$$;

update agent_versions version_row
set memory_mode = project_agent_memory_mode(version_row.memory_policy),
    configuration_hash = compute_agent_version_configuration_hash(version_row);

create trigger agent_versions_configuration_hash_trigger
before insert on agent_versions
for each row execute function set_agent_version_configuration_hash();

create trigger agent_versions_immutable_trigger
before update on agent_versions
for each row execute function reject_agent_version_update();

comment on column agent_versions.memory_policy is
  'Immutable format-v1 execution policy for history, Persona/project context, durable read/write, and subagent sharing.';

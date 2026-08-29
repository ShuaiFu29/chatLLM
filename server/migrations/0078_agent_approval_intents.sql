-- Bind every human decision to the exact operation that may execute.
--
-- The intent is immutable and fingerprints tool identity/version, arguments,
-- target, risk and the complete inherited approval-policy chain. PostgreSQL
-- validates the canonical approval Step when a row is created and once more at
-- pending -> approved. The runtime independently recomputes the same intent
-- immediately before execution, including after worker recovery.

create or replace function canonical_agent_approval_json(input_value jsonb)
returns text
language plpgsql
immutable
strict
parallel safe
as $$
declare
  result text;
  entry record;
  first_entry boolean;
begin
  case jsonb_typeof(input_value)
    when 'object' then
      result := '{';
      first_entry := true;
      for entry in
        select item.key, item.value
        from jsonb_each(input_value) item
        order by item.key collate "C"
      loop
        if not first_entry then result := result || ','; end if;
        result := result
          || to_jsonb(entry.key)::text
          || ':'
          || canonical_agent_approval_json(entry.value);
        first_entry := false;
      end loop;
      return result || '}';
    when 'array' then
      result := '[';
      first_entry := true;
      for entry in
        select item.value
        from jsonb_array_elements(input_value) with ordinality item(value, ordinality)
        order by item.ordinality
      loop
        if not first_entry then result := result || ','; end if;
        result := result || canonical_agent_approval_json(entry.value);
        first_entry := false;
      end loop;
      return result || ']';
    else
      return input_value::text;
  end case;
end;
$$;

create or replace function hash_agent_approval_json(input_value jsonb)
returns text
language sql
immutable
strict
parallel safe
as $$
  select encode(
    digest(convert_to(canonical_agent_approval_json(input_value), 'UTF8'), 'sha256'),
    'hex'
  )
$$;

alter table agent_approvals
  add column if not exists intent jsonb;
alter table agent_approvals
  add column if not exists intent_hash text;

-- An approval created by pre-intent code cannot safely authorize a post-intent
-- execution. Invalidate it rather than inventing approval evidence during the
-- migration. Historical terminal rows get an explicit legacy projection below
-- so audit screens remain readable but runtime revalidation can never reuse it.
with invalidated as (
  update agent_approvals
  set status = 'expired',
      reason = case
        when reason = '' then 'Invalidated by immutable approval intent upgrade'
        else reason
      end,
      decided_at = coalesce(decided_at, now())
  where status = 'pending'
  returning step_id
)
update agent_steps step
set status = 'failed',
    output = coalesce(step.output, '{}'::jsonb) || jsonb_build_object(
      'decision', 'expired',
      'reason', 'Invalidated by immutable approval intent upgrade'
    )
from invalidated
where step.id = invalidated.step_id
  and step.status in ('pending', 'running');

-- A crashed/parked worker has no in-process waiter to observe that invalidation.
-- Requeue it so recovery reads the expired decision and fails the old Run closed.
update agent_work_items work
set status = 'queued', available_at = now(), updated_at = now()
from agent_run_checkpoints checkpoint, agent_approvals approval
where approval.status = 'expired'
  and approval.reason = 'Invalidated by immutable approval intent upgrade'
  and work.run_id = coalesce(approval.requested_by_run_id, approval.run_id)
  and work.status = 'waiting'
  and checkpoint.run_id = work.run_id
  and checkpoint.boundary = 'approval_wait'
  and checkpoint.payload #>> '{pending,approvalId}' = approval.id::text;

update agent_approvals approval
set intent = jsonb_build_object(
      'format_version', 1,
      'tool_key', coalesce(nullif(step.tool_key, ''), 'legacy:unknown'),
      'tool_kind', 'builtin',
      'tool_version_id', null,
      'configuration_hash', null,
      'secret_version', null,
      'input_hash', hash_agent_approval_json(coalesce(step.input, '{}'::jsonb)),
      'target', null,
      'method', 'legacy-unbound',
      'risk_level', case
        when step.output ->> 'risk_level' in ('read', 'write', 'high')
          then step.output ->> 'risk_level'
        else 'read'
      end,
      'policy_chain', jsonb_build_array('never'),
      'side_effect_summary', 'Legacy approval record; not valid for a new execution.'
    )
from agent_steps step
where approval.intent is null
  and step.id = approval.step_id;

update agent_approvals approval
set intent = jsonb_build_object(
      'format_version', 1,
      'tool_key', 'legacy:unknown',
      'tool_kind', 'builtin',
      'tool_version_id', null,
      'configuration_hash', null,
      'secret_version', null,
      'input_hash', hash_agent_approval_json('{}'::jsonb),
      'target', null,
      'method', 'legacy-unbound',
      'risk_level', 'read',
      'policy_chain', jsonb_build_array('never'),
      'side_effect_summary', 'Legacy approval record without a Step; not valid for a new execution.'
    )
where approval.intent is null;

update agent_approvals
set intent_hash = hash_agent_approval_json(intent)
where intent_hash is null;

create or replace function valid_agent_approval_intent(value jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  policy jsonb;
begin
  if jsonb_typeof(value) <> 'object'
     or (select count(*) from jsonb_object_keys(value)) <> 12
     or not value ?& array[
       'format_version', 'tool_key', 'tool_kind', 'tool_version_id',
       'configuration_hash', 'secret_version', 'input_hash', 'target',
       'method', 'risk_level', 'policy_chain', 'side_effect_summary'
     ]
     or value ->> 'format_version' <> '1'
     or coalesce(value ->> 'tool_key', '') = ''
     or length(value ->> 'tool_key') > 300
     or value ->> 'tool_kind' not in ('builtin', 'http', 'mcp', 'memory', 'subagent')
     or jsonb_typeof(value -> 'input_hash') <> 'string'
     or not ((value ->> 'input_hash') ~ '^[0-9a-f]{64}$')
     or coalesce(value ->> 'method', '') = ''
     or length(value ->> 'method') > 160
     or value ->> 'risk_level' not in ('read', 'write', 'high')
     or jsonb_typeof(value -> 'policy_chain') <> 'array'
     or jsonb_array_length(value -> 'policy_chain') not between 1 and 32
     or coalesce(value ->> 'side_effect_summary', '') = ''
     or length(value ->> 'side_effect_summary') > 1000
  then
    return false;
  end if;

  if jsonb_typeof(value -> 'tool_version_id') not in ('null', 'string')
     or (
       jsonb_typeof(value -> 'tool_version_id') = 'string'
       and not ((value ->> 'tool_version_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     )
     or jsonb_typeof(value -> 'configuration_hash') not in ('null', 'string')
     or (
       jsonb_typeof(value -> 'configuration_hash') = 'string'
       and not ((value ->> 'configuration_hash') ~ '^[0-9a-f]{64}$')
     )
     or jsonb_typeof(value -> 'secret_version') not in ('null', 'number')
     or (
       jsonb_typeof(value -> 'secret_version') = 'number'
       and (value ->> 'secret_version')::integer <= 0
     )
     or jsonb_typeof(value -> 'target') not in ('null', 'string')
     or (
       jsonb_typeof(value -> 'target') = 'string'
       and length(value ->> 'target') > 2000
     )
  then
    return false;
  end if;

  for policy in
    select entry.policy_value
    from jsonb_array_elements(value -> 'policy_chain') entry(policy_value)
  loop
    if jsonb_typeof(policy) <> 'string'
       or policy #>> '{}' not in ('never', 'writes', 'always')
    then
      return false;
    end if;
  end loop;

  if value ->> 'method' <> 'legacy-unbound' then
    if value ->> 'tool_kind' in ('http', 'mcp') then
      if not ((value ->> 'tool_key') ~* '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
         or jsonb_typeof(value -> 'tool_version_id') <> 'string'
         or jsonb_typeof(value -> 'configuration_hash') <> 'string'
         or jsonb_typeof(value -> 'secret_version') <> 'number'
         or jsonb_typeof(value -> 'target') <> 'string'
      then
        return false;
      end if;
    elsif jsonb_typeof(value -> 'tool_version_id') <> 'null'
       or jsonb_typeof(value -> 'configuration_hash') <> 'null'
       or jsonb_typeof(value -> 'secret_version') <> 'null'
    then
      return false;
    end if;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

alter table agent_approvals
  alter column intent set not null;
alter table agent_approvals
  alter column intent_hash set not null;
alter table agent_approvals
  drop constraint if exists agent_approvals_intent_shape_check;
alter table agent_approvals
  add constraint agent_approvals_intent_shape_check
  check (valid_agent_approval_intent(intent));
alter table agent_approvals
  drop constraint if exists agent_approvals_intent_hash_check;
alter table agent_approvals
  add constraint agent_approvals_intent_hash_check
  check (
    intent_hash ~ '^[0-9a-f]{64}$'
    and intent_hash = hash_agent_approval_json(intent)
  );

create or replace function enforce_agent_approval_intent()
returns trigger
language plpgsql
as $$
declare
  canonical_tool_key text;
  canonical_input jsonb;
begin
  if tg_op = 'UPDATE' and (
    new.intent is distinct from old.intent
    or new.intent_hash is distinct from old.intent_hash
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'agent_approvals_intent_immutable_check',
      message = 'Agent approval intent is immutable';
  end if;

  -- Creation and approval both prove the intent still names the canonical Step.
  if tg_op = 'INSERT'
     or (old.status = 'pending' and new.status = 'approved')
  then
    select step.tool_key, step.input
    into canonical_tool_key, canonical_input
    from agent_steps step
    where step.id = new.step_id
      and step.kind = 'approval';

    if not found
       or canonical_tool_key is distinct from new.intent ->> 'tool_key'
       or hash_agent_approval_json(canonical_input) is distinct from new.intent ->> 'input_hash'
       or new.intent_hash is distinct from hash_agent_approval_json(new.intent)
    then
      raise exception using
        errcode = '23514',
        constraint = 'agent_approvals_intent_step_binding_check',
        message = 'Agent approval intent does not match its canonical Step';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists agent_approvals_intent_trigger on agent_approvals;
create trigger agent_approvals_intent_trigger
before insert or update on agent_approvals
for each row execute function enforce_agent_approval_intent();

create or replace function enforce_agent_approval_step_binding()
returns trigger
language plpgsql
as $$
begin
  if (new.tool_key is distinct from old.tool_key or new.input is distinct from old.input)
     and exists (select 1 from agent_approvals approval where approval.step_id = old.id)
  then
    raise exception using
      errcode = '23514',
      constraint = 'agent_approval_step_binding_immutable_check',
      message = 'A Step bound to an Agent approval cannot change tool or input';
  end if;
  return new;
end;
$$;

drop trigger if exists agent_approval_step_binding_trigger on agent_steps;
create trigger agent_approval_step_binding_trigger
before update of tool_key, input on agent_steps
for each row execute function enforce_agent_approval_step_binding();

create index if not exists agent_approvals_user_pending_inbox_idx
  on agent_approvals (user_id, created_at desc, id desc)
  where status = 'pending';

comment on column agent_approvals.intent is
  'Immutable operation approved by the user: tool/version, input hash, safe target, risk, policy chain and side-effect summary.';
comment on column agent_approvals.intent_hash is
  'SHA-256 of canonical_agent_approval_json(intent), revalidated before tool execution.';

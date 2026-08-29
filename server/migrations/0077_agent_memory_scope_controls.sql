-- R4 Memory governance: user-controlled scope gates and database-enforced active
-- row quotas. A disabled scope retains its reviewable history but cannot be
-- recalled or receive new content.

create table if not exists agent_memory_scope_settings (
  user_id uuid not null references users(id) on delete cascade,
  scope text not null,
  enabled boolean not null default true,
  max_active_memories integer not null default 500,
  updated_at timestamptz not null default now(),
  primary key (user_id, scope),
  constraint agent_memory_scope_settings_scope_check
    check (scope in ('user', 'project', 'agent')),
  constraint agent_memory_scope_settings_quota_check
    check (max_active_memories between 1 and 5000)
);

create or replace function enforce_agent_memory_scope_write()
returns trigger
language plpgsql
as $$
declare
  scope_enabled boolean := true;
  scope_quota integer := 500;
  active_count integer;
begin
  -- Serialize quota admission with every other write in this user's scope. The
  -- lock key is stable but contains no personal content.
  perform pg_advisory_xact_lock(
    hashtextextended('agent-memory-scope:' || new.user_id::text || ':' || new.scope, 0)
  );

  select enabled, max_active_memories
  into scope_enabled, scope_quota
  from agent_memory_scope_settings
  where user_id = new.user_id and scope = new.scope;

  if not found then
    scope_enabled := true;
    scope_quota := 500;
  end if;

  if not scope_enabled then
    raise exception using
      errcode = '23514',
      constraint = 'agent_memories_scope_enabled_check',
      message = 'Agent Memory scope is disabled by the user';
  end if;

  -- INSERT triggers also run before ON CONFLICT. An exact active duplicate is an
  -- update to an existing logical Memory and must remain legal at the quota.
  if exists (
    select 1
    from agent_memories existing
    where existing.user_id = new.user_id
      and existing.scope = new.scope
      and existing.scope_ref_id is not distinct from new.scope_ref_id
      and existing.kind = new.kind
      and md5(existing.content) = md5(new.content)
      and existing.status in ('candidate', 'confirmed')
      and existing.superseded_by is null
      and existing.deleted_at is null
  ) then
    return new;
  end if;

  select count(*)::integer
  into active_count
  from agent_memories existing
  where existing.user_id = new.user_id
    and existing.scope = new.scope
    and existing.status in ('candidate', 'confirmed')
    and existing.superseded_by is null
    and existing.deleted_at is null
    and (existing.expires_at is null or existing.expires_at > now());

  if active_count >= scope_quota then
    raise exception using
      errcode = '23514',
      constraint = 'agent_memories_scope_quota_check',
      message = 'Agent Memory scope quota exceeded';
  end if;
  return new;
end;
$$;

drop trigger if exists agent_memories_scope_write_guard on agent_memories;
create trigger agent_memories_scope_write_guard
before insert on agent_memories
for each row execute function enforce_agent_memory_scope_write();

create index if not exists agent_memory_scope_settings_disabled_idx
  on agent_memory_scope_settings(user_id, scope)
  where not enabled;

comment on table agent_memory_scope_settings is
  'User-controlled Memory scope gates and hard active-row quotas. Disabling a scope stops recall and new writes without hiding its review history.';

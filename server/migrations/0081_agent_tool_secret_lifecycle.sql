-- Append-only credential lifecycle evidence for custom Agent tools. Secret
-- values and Secret key names are deliberately absent: the audit log proves
-- when a credential was configured or used without becoming another secret
-- store.

create table if not exists agent_tool_secret_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  tool_id uuid not null references agent_tools(id) on delete cascade,
  tool_version_id uuid references agent_tool_versions(id) on delete set null,
  run_id uuid,
  agent_id uuid,
  event_type text not null,
  secret_version integer not null,
  envelope_version smallint,
  encryption_key_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_tool_secret_events_type_check check (
    event_type in ('configured', 'replaced', 'cleared', 'used', 'decrypt_failed', 'rewrapped')
  ),
  constraint agent_tool_secret_events_secret_version_check check (secret_version > 0),
  constraint agent_tool_secret_events_envelope_version_check check (
    envelope_version is null or envelope_version in (1, 2)
  ),
  constraint agent_tool_secret_events_key_id_check check (
    encryption_key_id is null or encryption_key_id ~ '^[A-Za-z0-9_-]{1,64}$'
  ),
  constraint agent_tool_secret_events_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists agent_tool_secret_events_user_created_idx
  on agent_tool_secret_events(user_id, created_at desc, id desc);
create index if not exists agent_tool_secret_events_tool_created_idx
  on agent_tool_secret_events(tool_id, created_at desc, id desc);
create index if not exists agent_tool_secret_events_run_created_idx
  on agent_tool_secret_events(run_id, created_at desc, id desc)
  where run_id is not null;

create or replace function reject_agent_tool_secret_event_mutation()
returns trigger
language plpgsql
as $$
begin
  -- Account deletion is a privacy erasure boundary. PostgreSQL's user cascade
  -- runs after the parent row disappears, so allow only that database-owned
  -- delete path; ordinary application updates/deletes remain impossible.
  if tg_op = 'DELETE' and not exists (
    select 1 from users where id = old.user_id
  ) then
    return old;
  end if;
  raise exception using
    errcode = '23514',
    constraint = 'agent_tool_secret_events_append_only_check',
    message = 'Agent tool Secret events are append-only';
end;
$$;

drop trigger if exists agent_tool_secret_events_append_only_trigger
  on agent_tool_secret_events;
create trigger agent_tool_secret_events_append_only_trigger
before update or delete on agent_tool_secret_events
for each row execute function reject_agent_tool_secret_event_mutation();

comment on table agent_tool_secret_events is
  'Append-only Secret configuration, rotation, decryption, and use evidence; never stores Secret names or values.';
comment on column agent_tool_secret_events.encryption_key_id is
  'Non-secret key identifier embedded in a v2 envelope; null for legacy v1 or cleared credentials.';

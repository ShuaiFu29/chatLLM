create table if not exists agent_audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  tool_id uuid references agent_tools(id) on delete set null,
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_audit_events_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

create index if not exists agent_audit_events_user_created_idx
  on agent_audit_events (user_id, created_at desc);
create index if not exists agent_audit_events_agent_created_idx
  on agent_audit_events (agent_id, created_at desc)
  where agent_id is not null;
create index if not exists agent_audit_events_tool_created_idx
  on agent_audit_events (tool_id, created_at desc)
  where tool_id is not null;

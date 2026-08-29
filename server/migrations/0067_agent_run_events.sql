-- Durable Agent events decouple execution from whichever HTTP process owns an
-- SSE connection. PostgreSQL is the replay source; live delivery is only an
-- optimization over this append-only log.
create table if not exists agent_run_events (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  root_run_id uuid not null,
  event_key text not null,
  format_version smallint not null default 1,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint agent_run_events_run_root_fkey
    foreign key (run_id, root_run_id)
    references agent_runs(id, root_run_id) on delete cascade,
  constraint agent_run_events_key_check
    check (length(event_key) between 1 and 512),
  constraint agent_run_events_format_check
    check (format_version = 1),
  constraint agent_run_events_payload_object_check
    check (jsonb_typeof(payload) = 'object'),
  constraint agent_run_events_payload_size_check
    check (octet_length(payload::text) <= 262144),
  constraint agent_run_events_run_key_unique unique (run_id, event_key)
);

create index if not exists agent_run_events_run_cursor_idx
  on agent_run_events(run_id, id);

create index if not exists agent_run_events_root_cursor_idx
  on agent_run_events(root_run_id, id);

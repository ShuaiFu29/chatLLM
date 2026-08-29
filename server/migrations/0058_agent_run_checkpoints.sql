-- Versioned, fenced continuation records for Agent Runs.
--
-- A checkpoint is written only at a runtime-defined safe boundary. It is not a
-- claim by itself: delegated Runs are still owned by agent_runs.lease_token and
-- root Run ownership will be generalized by the Durable Runtime worker. The
-- generation compare-and-swap prevents an older execution path from overwriting
-- a checkpoint already advanced by a newer path.
create table if not exists agent_run_checkpoints (
  run_id uuid primary key,
  root_run_id uuid not null,
  generation bigint not null,
  format_version smallint not null,
  boundary text not null,
  payload jsonb not null,
  state_hash text not null,
  owner_lease_token uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_run_checkpoints_run_tree_fk
    foreign key (run_id, root_run_id)
    references agent_runs(id, root_run_id) on delete cascade,
  constraint agent_run_checkpoints_generation_check check (generation > 0),
  constraint agent_run_checkpoints_format_version_check check (format_version = 1),
  constraint agent_run_checkpoints_boundary_check check (boundary in (
    'model_ready', 'tool_batch_ready', 'approval_wait',
    'subagents_wait', 'final_answer_ready'
  )),
  constraint agent_run_checkpoints_payload_object_check
    check (jsonb_typeof(payload) = 'object'),
  constraint agent_run_checkpoints_state_hash_check
    check (state_hash ~ '^[0-9a-f]{64}$'),
  -- The application may configure a smaller ceiling. This hard database ceiling
  -- remains as defense in depth for callers that bypass the TypeScript contract.
  constraint agent_run_checkpoints_payload_size_check
    check (octet_length(payload::text) <= 262144)
);

create index if not exists agent_run_checkpoints_root_updated_idx
  on agent_run_checkpoints(root_run_id, updated_at desc);

comment on table agent_run_checkpoints is
  'Latest versioned continuation state for one Agent Run. A row is resumable only when the owning Run is active and its execution claim is valid.';

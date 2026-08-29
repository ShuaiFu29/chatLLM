-- A terminal tool status is not enough to resume a partially completed batch.
-- Persist the exact bounded content shown to the model plus the bounded evidence
-- input used by grounding, so a successful write is never replayed after crash.
alter table agent_tool_invocations
  add column if not exists result_format_version smallint,
  add column if not exists result_payload jsonb,
  add column if not exists result_hash text;

alter table agent_tool_invocations
  drop constraint if exists agent_tool_invocations_result_shape_check;

-- Historical succeeded rows have no snapshot and remain visible as explicitly
-- non-recoverable. New repository writes require all result fields on success.
alter table agent_tool_invocations
  add constraint agent_tool_invocations_result_shape_check check (
    (
      result_format_version is null
      and result_payload is null
      and result_hash is null
    )
    or (
      status = 'succeeded'
      and result_format_version = 1
      and jsonb_typeof(result_payload) = 'object'
      and jsonb_typeof(result_payload -> 'modelContent') = 'string'
      and result_hash ~ '^[0-9a-f]{64}$'
      and octet_length(result_payload::text) <= 262144
    )
  );

comment on column agent_tool_invocations.result_payload is
  'Exact bounded model content and grounding input for recovery without replaying the tool.';

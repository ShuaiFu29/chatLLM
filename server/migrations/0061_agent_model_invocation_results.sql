-- A successful provider call is not recoverable unless its validated response is
-- durable. Without this snapshot, a crash between provider settlement and the
-- next runtime checkpoint forces either duplicate model work or data loss.
alter table agent_model_invocations
  add column if not exists result_format_version smallint,
  add column if not exists result_payload jsonb,
  add column if not exists result_hash text;

-- A reservation released before the provider is contacted is observably
-- different from both estimated usage and an unknown provider outcome.
alter table agent_model_invocations
  drop constraint if exists agent_model_invocations_usage_source_check;

alter table agent_model_invocations
  add constraint agent_model_invocations_usage_source_check check (
    usage_source is null or usage_source in (
      'provider_reported', 'tokenizer_estimated', 'not_invoked',
      'reservation_conservative'
    )
  );

alter table agent_model_invocations
  drop constraint if exists agent_model_invocations_result_shape_check;

-- Historical succeeded rows legitimately have no result snapshot. Recovery
-- treats those as non-replayable. All new application settlements write the
-- three result fields together.
alter table agent_model_invocations
  add constraint agent_model_invocations_result_shape_check check (
    (
      result_format_version is null
      and result_payload is null
      and result_hash is null
    )
    or (
      status = 'succeeded'
      and result_format_version = 1
      and jsonb_typeof(result_payload) = 'object'
      and result_hash ~ '^[0-9a-f]{64}$'
      and octet_length(result_payload::text) <= 262144
    )
  );

comment on column agent_model_invocations.result_payload is
  'Bounded protocol-validated provider result used by recovery instead of replaying a succeeded invocation.';

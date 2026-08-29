-- Distinguish a checkpointed reservation from a model request that may already
-- have reached the provider. Existing reserved rows predate the marker and are
-- conservatively treated as exposed during rollout.
alter table agent_model_invocations
  add column if not exists exposure_started_at timestamptz;

update agent_model_invocations
set exposure_started_at = created_at
where status = 'reserved' and exposure_started_at is null;

create index if not exists agent_model_invocations_unexposed_idx
  on agent_model_invocations(created_at)
  where status = 'reserved' and exposure_started_at is null;

comment on column agent_model_invocations.exposure_started_at is
  'Set under the current Work Item fence immediately before the provider request can start.';

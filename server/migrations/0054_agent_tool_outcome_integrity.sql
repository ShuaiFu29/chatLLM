-- A stable request id is not, by itself, proof that a downstream tool honours
-- idempotency. Persist the contract used by the runtime and distinguish a
-- definite failure from a call that may already have applied a side effect.
alter table agent_tool_invocations
  add column if not exists retry_mode text not null default 'never',
  add column if not exists error_code text;

alter table agent_tool_invocations
  drop constraint if exists agent_tool_invocations_status_check;

alter table agent_tool_invocations
  add constraint agent_tool_invocations_status_check
    check (status in ('in_flight', 'succeeded', 'failed', 'indeterminate'));

alter table agent_tool_invocations
  drop constraint if exists agent_tool_invocations_retry_mode_check;

alter table agent_tool_invocations
  add constraint agent_tool_invocations_retry_mode_check
    check (retry_mode in ('safe_read', 'idempotent_write', 'never'));

-- Old rows predate the explicit retry contract. `never` is the only safe
-- backfill: treating them as idempotent would invent a downstream guarantee.
update agent_tool_invocations
set retry_mode = 'never'
where retry_mode is null;

update agent_tool_invocations
set error_code = 'legacy_tool_failure'
where status = 'failed' and error_code is null;

update agent_tool_invocations
set completed_at = null,
    error_code = null
where status = 'in_flight';

update agent_tool_invocations
set completed_at = coalesce(completed_at, updated_at, now()),
    error_code = null
where status = 'succeeded';

update agent_tool_invocations
set completed_at = coalesce(completed_at, updated_at, now())
where status = 'failed';

alter table agent_tool_invocations
  drop constraint if exists agent_tool_invocations_terminal_metadata_check;

alter table agent_tool_invocations
  add constraint agent_tool_invocations_terminal_metadata_check check (
    (status = 'in_flight' and completed_at is null and error_code is null)
    or (status = 'succeeded' and completed_at is not null and error_code is null)
    or (status in ('failed', 'indeterminate') and completed_at is not null and error_code is not null)
  );

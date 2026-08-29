-- The idempotency key identifies one logical call; it does not identify the
-- process currently allowed to execute it. Fence that execution right so two
-- runtimes cannot both replay the same in-flight invocation, and so a stale
-- runtime cannot overwrite a terminal outcome.
alter table agent_tool_invocations
  add column if not exists execution_token uuid;

-- There is no safe way to transfer ownership of a call that was already in
-- flight when the old process disappeared. Preserve the uncertainty instead of
-- allowing the deployment to replay a potentially-applied write.
update agent_tool_invocations
set status = 'indeterminate',
    error_code = 'tool_execution_owner_lost',
    completed_at = coalesce(completed_at, now()),
    updated_at = now()
where status = 'in_flight';

update agent_tool_invocations
set execution_token = gen_random_uuid()
where execution_token is null;

alter table agent_tool_invocations
  alter column execution_token set not null;

comment on column agent_tool_invocations.execution_token is
  'Fencing token for one runtime execution; retries keep it, concurrent or stale runtimes cannot begin or finish with another token.';

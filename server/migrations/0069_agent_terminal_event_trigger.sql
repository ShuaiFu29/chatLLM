-- Repository-level terminal appends cover normal execution, but maintenance and
-- lease sweepers can terminalize a Run through different SQL paths. Make the
-- database transition itself the final outbox boundary. Application code may
-- replace this compact fallback payload later in the same transaction.
create or replace function append_agent_run_terminal_event()
returns trigger
language plpgsql
as $$
declare
  terminal_event_type text;
begin
  if new.parent_run_id is null then
    terminal_event_type := case new.status
      when 'succeeded' then 'run.completed'
      when 'cancelled' then 'run.cancelled'
      else 'run.failed'
    end;
  else
    terminal_event_type := case new.status
      when 'succeeded' then 'subagent.completed'
      else 'subagent.failed'
    end;
  end if;

  insert into agent_run_events (
    run_id, root_run_id, event_key, format_version, payload
  ) values (
    new.id,
    new.root_run_id,
    terminal_event_type,
    1,
    jsonb_strip_nulls(jsonb_build_object(
      'agentRunId', new.id,
      'terminalFallback', true,
      'agentEvent', jsonb_build_object(
        'type', terminal_event_type,
        'runId', new.id,
        'iterationCount', new.iteration_count,
        'toolCallCount', new.tool_call_count,
        'tokenUsage', coalesce(new.token_usage, '{}'::jsonb),
        'error', new.error_message
      )
    ))
  )
  on conflict (run_id, event_key) do nothing;

  return new;
end;
$$;

drop trigger if exists agent_runs_terminal_event_trigger on agent_runs;
create trigger agent_runs_terminal_event_trigger
after update of status on agent_runs
for each row
when (
  old.status in ('queued', 'running', 'waiting_approval', 'waiting_subagent')
  and new.status in ('succeeded', 'failed', 'cancelled')
)
execute function append_agent_run_terminal_event();

comment on function append_agent_run_terminal_event() is
  'Writes a compact durable terminal event for every Agent Run transition; richer repository events replace the fallback in the same transaction.';

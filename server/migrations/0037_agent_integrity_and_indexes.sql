-- Agent runtime integrity and audit indexes. Keep this migration separate from
-- 0036 so deployments that already ran the original schema can apply it safely.

alter table agent_runs
  add column if not exists agent_version_snapshot jsonb;

-- Preserve as much historical configuration as possible for runs created before
-- snapshots were introduced. New runs always write the complete snapshot from
-- the published version in the application layer.
update agent_runs run
set agent_version_snapshot = jsonb_build_object(
  'agent_id', run.agent_id,
  'agent_version_id', run.agent_version_id,
  'version', version.version,
  'instructions', version.instructions,
  'model', version.model,
  'temperature', version.temperature,
  'max_iterations', version.max_iterations,
  'max_duration_ms', version.max_duration_ms,
  'max_output_tokens', version.max_output_tokens,
  'memory_mode', version.memory_mode,
  'response_format', version.response_format,
  'output_schema', version.output_schema,
  'approval_policy', version.approval_policy,
  'tool_bindings', version.tool_bindings,
  'welcome_message', version.welcome_message,
  'suggested_prompts', version.suggested_prompts
)
from agent_versions version
where run.agent_version_snapshot is null
  and version.id = run.agent_version_id;

update agent_runs
set agent_version_snapshot = '{}'::jsonb
where agent_version_snapshot is null;

alter table agent_runs
  alter column agent_version_snapshot set default '{}'::jsonb,
  alter column agent_version_snapshot set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agent_runs_agent_version_snapshot_object_check'
      and conrelid = 'agent_runs'::regclass
  ) then
    alter table agent_runs
      add constraint agent_runs_agent_version_snapshot_object_check
      check (jsonb_typeof(agent_version_snapshot) = 'object');
  end if;
end $$;

-- Foreign-key columns are used in joins and in ON DELETE checks. The parent
-- side indexes in 0036 do not replace these child-side indexes.
create index if not exists agents_project_space_id_idx
  on agents (project_space_id)
  where project_space_id is not null;
create index if not exists agent_tools_project_space_id_idx
  on agent_tools (project_space_id)
  where project_space_id is not null;
create index if not exists agent_runs_agent_version_id_idx
  on agent_runs (agent_version_id)
  where agent_version_id is not null;
create index if not exists agent_approvals_user_id_idx
  on agent_approvals (user_id);

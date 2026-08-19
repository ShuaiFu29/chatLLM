-- Never implicitly turn project-scoped Agent resources into global resources.
-- The project-space cleanup path removes scoped Agents/tools explicitly before
-- deleting the parent workspace.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'agents_project_space_id_fkey'
      and conrelid = 'agents'::regclass
  ) then
    alter table agents drop constraint agents_project_space_id_fkey;
  end if;
  alter table agents
    add constraint agents_project_space_id_fkey
    foreign key (project_space_id) references project_spaces(id) on delete restrict;

  if exists (
    select 1 from pg_constraint
    where conname = 'agent_tools_project_space_id_fkey'
      and conrelid = 'agent_tools'::regclass
  ) then
    alter table agent_tools drop constraint agent_tools_project_space_id_fkey;
  end if;
  alter table agent_tools
    add constraint agent_tools_project_space_id_fkey
    foreign key (project_space_id) references project_spaces(id) on delete restrict;
end $$;

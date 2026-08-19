-- Persist the compact grounding decision for completed Agent runs. Sources
-- remain in messages.agent sources; this column intentionally stores only the
-- verification summary so run history can explain why evidence was accepted
-- or rejected without duplicating document contents.
alter table agent_runs
  add column if not exists grounding jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agent_runs_grounding_object_check'
      and conrelid = 'agent_runs'::regclass
  ) then
    alter table agent_runs
      add constraint agent_runs_grounding_object_check
      check (grounding is null or jsonb_typeof(grounding) = 'object');
  end if;
end $$;

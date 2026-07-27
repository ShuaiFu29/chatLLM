alter table rag_eval_cases
  add column if not exists evaluation_spec jsonb not null default '{}'::jsonb;

alter table rag_eval_run_cases
  add column if not exists evaluation_spec jsonb not null default '{}'::jsonb;

alter table rag_eval_runs
  add column if not exists advanced_metrics jsonb not null default '{}'::jsonb;

alter table rag_eval_results
  add column if not exists advanced_metrics jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rag_eval_cases_evaluation_spec_object_check'
      and conrelid = 'rag_eval_cases'::regclass
  ) then
    alter table rag_eval_cases
      add constraint rag_eval_cases_evaluation_spec_object_check
      check (jsonb_typeof(evaluation_spec) = 'object');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'rag_eval_run_cases_evaluation_spec_object_check'
      and conrelid = 'rag_eval_run_cases'::regclass
  ) then
    alter table rag_eval_run_cases
      add constraint rag_eval_run_cases_evaluation_spec_object_check
      check (jsonb_typeof(evaluation_spec) = 'object');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'rag_eval_runs_advanced_metrics_object_check'
      and conrelid = 'rag_eval_runs'::regclass
  ) then
    alter table rag_eval_runs
      add constraint rag_eval_runs_advanced_metrics_object_check
      check (jsonb_typeof(advanced_metrics) = 'object');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'rag_eval_results_advanced_metrics_object_check'
      and conrelid = 'rag_eval_results'::regclass
  ) then
    alter table rag_eval_results
      add constraint rag_eval_results_advanced_metrics_object_check
      check (jsonb_typeof(advanced_metrics) = 'object');
  end if;
end $$;

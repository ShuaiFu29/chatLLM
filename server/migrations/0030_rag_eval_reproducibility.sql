alter table rag_eval_runs
  add column if not exists execution_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists baseline_run_id uuid references rag_eval_runs(id) on delete set null;

alter table rag_eval_runs
  alter column average_answer_keyword_score drop not null,
  alter column average_answer_keyword_score drop default;

alter table rag_eval_results
  alter column answer_keyword_score drop not null,
  alter column answer_keyword_score drop default;

update rag_eval_runs
set average_answer_keyword_score = null
where average_answer_keyword_score is not null;

update rag_eval_results
set answer_keyword_score = null
where answer_keyword_score is not null;

create index if not exists rag_eval_runs_baseline_idx
  on rag_eval_runs(baseline_run_id)
  where baseline_run_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rag_eval_runs_execution_snapshot_object_check'
      and conrelid = 'rag_eval_runs'::regclass
  ) then
    alter table rag_eval_runs
      add constraint rag_eval_runs_execution_snapshot_object_check
      check (jsonb_typeof(execution_snapshot) = 'object');
  end if;
end $$;

comment on column rag_eval_runs.average_answer_keyword_score is
  'Deprecated compatibility metric. NULL because keyword overlap is not a valid answer-quality score.';
comment on column rag_eval_results.answer_keyword_score is
  'Deprecated compatibility metric. NULL because keyword overlap is not a valid answer-quality score.';

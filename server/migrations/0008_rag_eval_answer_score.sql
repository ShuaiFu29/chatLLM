alter table rag_eval_runs
  add column if not exists average_answer_score double precision not null default 0;

alter table rag_eval_results
  add column if not exists answer_score double precision not null default 0;

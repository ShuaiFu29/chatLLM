alter table rag_eval_runs
  add column if not exists average_expected_answer_support_score double precision not null default 0;

alter table rag_eval_results
  add column if not exists expected_answer_support_score double precision not null default 0,
  add column if not exists expected_answer_support_label text not null default 'unknown';

create index if not exists rag_eval_results_expected_answer_support_idx
  on rag_eval_results(run_id, expected_answer_support_score asc, expected_answer_support_label);

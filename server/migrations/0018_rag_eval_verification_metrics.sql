alter table rag_eval_runs
  add column if not exists average_verification_score double precision not null default 0;

alter table rag_eval_results
  add column if not exists verification_score double precision not null default 0,
  add column if not exists support_label text not null default 'unsupported',
  add column if not exists risk_level text not null default 'unknown';

create index if not exists rag_eval_results_verification_idx
  on rag_eval_results(run_id, verification_score asc, support_label);

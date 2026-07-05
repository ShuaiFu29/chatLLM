alter table rag_eval_runs
  drop constraint if exists rag_eval_runs_status_check;

alter table rag_eval_runs
  add constraint rag_eval_runs_status_check
  check (status in ('running', 'completed', 'failed', 'partial', 'cancelled'));

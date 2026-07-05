alter table rag_eval_runs
  drop constraint if exists rag_eval_runs_status_check;

alter table rag_eval_runs
  add constraint rag_eval_runs_status_check
  check (status in ('running', 'completed', 'failed', 'partial'));

create index if not exists rag_eval_runs_running_user_idx
  on rag_eval_runs(user_id, created_at desc)
  where status = 'running';

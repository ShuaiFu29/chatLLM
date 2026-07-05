alter table rag_eval_runs
  add column if not exists queued_at timestamptz not null default now(),
  add column if not exists claimed_at timestamptz,
  add column if not exists worker_id text,
  add column if not exists attempts integer not null default 0,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_error text not null default '';

update rag_eval_runs
set queued_at = coalesce(queued_at, created_at),
    max_attempts = greatest(max_attempts, 3)
where queued_at is null
   or max_attempts < 3;

create index if not exists rag_eval_runs_queue_ready_idx
  on rag_eval_runs(status, next_attempt_at, queued_at)
  where status = 'running' and claimed_at is null;

create index if not exists rag_eval_runs_claimed_idx
  on rag_eval_runs(claimed_at)
  where status = 'running' and claimed_at is not null;

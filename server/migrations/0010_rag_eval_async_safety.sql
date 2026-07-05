with duplicate_running_runs as (
  select
    id,
    row_number() over (
      partition by dataset_id
      order by created_at desc, id desc
    ) as run_rank
  from rag_eval_runs
  where status = 'running'
)
update rag_eval_runs r
set status = 'failed',
    failed_count = case_count,
    completed_at = now()
from duplicate_running_runs d
where r.id = d.id
  and d.run_rank > 1;

create unique index if not exists rag_eval_runs_one_running_dataset_idx
  on rag_eval_runs(dataset_id)
  where status = 'running';

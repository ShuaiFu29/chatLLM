create table if not exists rag_eval_run_cases (
  run_id uuid not null references rag_eval_runs(id) on delete cascade,
  case_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  question text not null,
  expected_answer text not null default '',
  expected_keywords text[] not null default '{}'::text[],
  expected_source_files text[] not null default '{}'::text[],
  case_created_at timestamptz not null,
  case_updated_at timestamptz not null,
  snapshotted_at timestamptz not null default now(),
  primary key (run_id, case_id),
  unique (run_id, ordinal)
);

create index if not exists rag_eval_run_cases_run_ordinal_idx
  on rag_eval_run_cases(run_id, ordinal);

with ordered_cases as (
  select
    r.id as run_id,
    c.id as case_id,
    (row_number() over (
      partition by r.id
      order by c.created_at asc, c.id asc
    ) - 1)::integer as ordinal,
    c.question,
    c.expected_answer,
    c.expected_keywords,
    c.expected_source_files,
    c.created_at as case_created_at,
    c.updated_at as case_updated_at,
    r.case_count
  from rag_eval_runs r
  join rag_eval_cases c
    on c.dataset_id = r.dataset_id
   and c.user_id = r.user_id
)
insert into rag_eval_run_cases (
  run_id,
  case_id,
  ordinal,
  question,
  expected_answer,
  expected_keywords,
  expected_source_files,
  case_created_at,
  case_updated_at
)
select
  run_id,
  case_id,
  ordinal,
  question,
  expected_answer,
  expected_keywords,
  expected_source_files,
  case_created_at,
  case_updated_at
from ordered_cases
where ordinal < case_count
on conflict (run_id, case_id) do nothing;

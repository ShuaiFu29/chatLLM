create table if not exists rag_eval_datasets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_space_id uuid references project_spaces(id) on delete set null,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists rag_eval_datasets_user_lower_name_idx
  on rag_eval_datasets(user_id, lower(name));

create index if not exists rag_eval_datasets_user_updated_idx
  on rag_eval_datasets(user_id, updated_at desc);

create table if not exists rag_eval_cases (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references rag_eval_datasets(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  question text not null,
  expected_answer text not null default '',
  expected_keywords text[] not null default '{}'::text[],
  expected_source_files text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rag_eval_cases_dataset_created_idx
  on rag_eval_cases(dataset_id, created_at asc);

create table if not exists rag_eval_runs (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references rag_eval_datasets(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null default 'completed',
  case_count integer not null default 0,
  failed_count integer not null default 0,
  average_overall_score double precision not null default 0,
  average_retrieval_score double precision not null default 0,
  average_source_score double precision not null default 0,
  average_keyword_score double precision not null default 0,
  duration_ms integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint rag_eval_runs_status_check check (status in ('completed', 'failed', 'partial'))
);

create index if not exists rag_eval_runs_dataset_created_idx
  on rag_eval_runs(dataset_id, created_at desc);

create table if not exists rag_eval_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references rag_eval_runs(id) on delete cascade,
  case_id uuid references rag_eval_cases(id) on delete set null,
  question text not null,
  status text not null default 'success',
  overall_score double precision not null default 0,
  retrieval_score double precision not null default 0,
  source_score double precision not null default 0,
  keyword_score double precision not null default 0,
  evidence_label text not null default 'weak',
  matched_sources jsonb not null default '[]'::jsonb,
  trace_summary jsonb not null default '{}'::jsonb,
  error_message text not null default '',
  created_at timestamptz not null default now(),
  constraint rag_eval_results_status_check check (status in ('success', 'failed'))
);

create index if not exists rag_eval_results_run_created_idx
  on rag_eval_results(run_id, created_at asc);

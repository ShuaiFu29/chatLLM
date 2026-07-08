create table if not exists file_ingestion_jobs (
  file_id uuid primary key references files(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  project_space_id uuid references project_spaces(id) on delete set null,
  status text not null default 'queued',
  stage text not null default 'queued',
  progress integer not null default 0,
  total_chunks integer not null default 0,
  indexed_chunks integer not null default 0,
  keyword_batches integer not null default 0,
  graph_batches integer not null default 0,
  vector_batches integer not null default 0,
  checkpoint jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint file_ingestion_jobs_status_check check (
    status in ('queued', 'processing', 'completed', 'failed', 'cancelled')
  ),
  constraint file_ingestion_jobs_progress_check check (progress between 0 and 100),
  constraint file_ingestion_jobs_chunks_check check (
    total_chunks >= 0 and indexed_chunks >= 0 and indexed_chunks <= greatest(total_chunks, indexed_chunks)
  ),
  constraint file_ingestion_jobs_batches_check check (
    keyword_batches >= 0 and graph_batches >= 0 and vector_batches >= 0
  )
);

create index if not exists file_ingestion_jobs_user_status_idx
  on file_ingestion_jobs(user_id, status, updated_at desc);

create index if not exists file_ingestion_jobs_project_status_idx
  on file_ingestion_jobs(project_space_id, status, updated_at desc);

create index if not exists file_ingestion_jobs_heartbeat_idx
  on file_ingestion_jobs(status, heartbeat_at)
  where status in ('queued', 'processing');

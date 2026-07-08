create table if not exists upload_multipart_sessions (
  file_id uuid primary key references files(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  project_space_id uuid references project_spaces(id) on delete set null,
  object_key text not null,
  storage_upload_id text not null,
  part_size bigint not null,
  total_parts integer not null,
  status text not null default 'initiated',
  expires_at timestamptz not null,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upload_multipart_sessions_part_size_check check (part_size >= 5242880),
  constraint upload_multipart_sessions_total_parts_check check (total_parts between 1 and 10000),
  constraint upload_multipart_sessions_status_check check (
    status in ('initiated', 'uploading', 'completing', 'completed', 'failed', 'cancelled', 'expired')
  )
);

create index if not exists upload_multipart_sessions_user_status_idx
  on upload_multipart_sessions(user_id, status, expires_at);

create index if not exists upload_multipart_sessions_project_space_status_idx
  on upload_multipart_sessions(project_space_id, status, expires_at);

create index if not exists upload_multipart_sessions_expires_at_idx
  on upload_multipart_sessions(expires_at)
  where status in ('initiated', 'uploading', 'completing');

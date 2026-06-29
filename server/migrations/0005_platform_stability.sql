create extension if not exists pg_trgm;

alter table files
  add column if not exists attempts integer not null default 0;

alter table files
  add column if not exists max_attempts integer not null default 3;

alter table files
  add column if not exists next_attempt_at timestamptz;

alter table files
  add column if not exists last_attempt_at timestamptz;

create index if not exists files_queue_claim_idx
  on files(status, next_attempt_at, updated_at, created_at)
  where status in ('pending', 'failed', 'processing');

create index if not exists messages_content_trgm_idx
  on messages using gin(content gin_trgm_ops);

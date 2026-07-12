alter table sessions add column if not exists token_hash text;

update sessions
set token_hash = encode(sha256(convert_to(id::text, 'UTF8')), 'hex')
where token_hash is null;

alter table sessions
  add column if not exists session_id uuid not null default gen_random_uuid();

alter table sessions drop constraint if exists sessions_pkey;
alter table sessions drop column id;
alter table sessions rename column session_id to id;
alter table sessions add primary key (id);
alter table sessions alter column token_hash set not null;
alter table sessions
  add constraint sessions_token_hash_length_check
  check (char_length(token_hash) = 64);

create unique index if not exists sessions_token_hash_idx
  on sessions(token_hash);

create table if not exists rate_limit_buckets (
  bucket_key text primary key,
  window_started_at timestamptz not null,
  request_count integer not null,
  expires_at timestamptz not null,
  constraint rate_limit_buckets_request_count_check
    check (request_count > 0),
  constraint rate_limit_buckets_window_check
    check (expires_at > window_started_at)
);

create index if not exists rate_limit_buckets_expires_at_idx
  on rate_limit_buckets(expires_at);

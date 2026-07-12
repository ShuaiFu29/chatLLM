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

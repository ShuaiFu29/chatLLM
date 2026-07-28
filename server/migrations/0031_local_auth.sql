alter table users alter column github_id drop not null;

alter table users add column if not exists email text;
alter table users add column if not exists password_hash text;

alter table users drop constraint if exists users_email_normalized_check;
alter table users
  add constraint users_email_normalized_check
  check (
    email is null
    or (
      email = lower(btrim(email))
      and char_length(email) between 3 and 320
    )
  );

alter table users drop constraint if exists users_local_credentials_pair_check;
alter table users
  add constraint users_local_credentials_pair_check
  check (
    (email is null and password_hash is null)
    or (email is not null and password_hash is not null)
  );

alter table users drop constraint if exists users_login_method_check;
alter table users
  add constraint users_login_method_check
  check (github_id is not null or email is not null);

alter table users drop constraint if exists users_password_hash_format_check;
alter table users
  add constraint users_password_hash_format_check
  check (password_hash is null or password_hash like 'scrypt$v1$%');

create unique index if not exists users_email_unique_idx
  on users(email)
  where email is not null;

alter table sessions
  add column if not exists remember_me boolean not null default true;

alter table sessions alter column remember_me set default false;

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  github_id bigint unique not null,
  username text not null,
  avatar_url text not null default '',
  avatar_object_key text,
  display_name text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists project_spaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  description text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists project_spaces_one_default_per_user_idx on project_spaces(user_id) where is_default;
create unique index if not exists project_spaces_user_lower_name_idx on project_spaces(user_id, lower(name));
create index if not exists project_spaces_user_id_updated_at_idx on project_spaces(user_id, updated_at desc);

create table if not exists sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_expires_at_idx on sessions(expires_at);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_space_id uuid references project_spaces(id) on delete set null,
  title text not null default 'New Chat',
  model text,
  temperature double precision,
  system_prompt text,
  enable_rag boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_user_id_updated_at_idx on conversations(user_id, updated_at desc);
create index if not exists conversations_user_id_project_space_id_updated_at_idx on conversations(user_id, project_space_id, updated_at desc);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null,
  content text not null,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint messages_role_check check (role in ('user', 'assistant', 'system'))
);

create index if not exists messages_conversation_id_created_at_idx on messages(conversation_id, created_at);
create index if not exists messages_created_at_idx on messages(created_at desc);

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_space_id uuid references project_spaces(id) on delete set null,
  filename text not null,
  file_hash text not null,
  file_size bigint,
  file_type text,
  object_key text,
  status text not null default 'uploading',
  progress integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint files_status_check check (status in ('uploading', 'pending', 'processing', 'completed', 'failed'))
);

create index if not exists files_user_id_created_at_idx on files(user_id, created_at desc);
create index if not exists files_user_id_project_space_id_created_at_idx on files(user_id, project_space_id, created_at desc);
create index if not exists files_status_created_at_idx on files(status, created_at);
create index if not exists files_file_hash_idx on files(file_hash);

create table if not exists file_chunks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (file_id, chunk_index)
);

create index if not exists file_chunks_file_id_chunk_index_idx on file_chunks(file_id, chunk_index);
create index if not exists file_chunks_user_id_idx on file_chunks(user_id);

alter table conversations
  add column if not exists parent_conversation_id uuid references conversations(id) on delete set null;

alter table conversations
  add column if not exists branched_from_message_id uuid references messages(id) on delete set null;

alter table conversations
  add column if not exists branch_name text not null default '';

alter table conversations
  add column if not exists is_favorite boolean not null default false;

alter table conversations
  add column if not exists tags text[] not null default '{}'::text[];

alter table conversations
  add column if not exists note text not null default '';

create index if not exists conversations_user_id_favorite_updated_idx
  on conversations(user_id, is_favorite, updated_at desc);

create index if not exists conversations_tags_gin_idx
  on conversations using gin(tags);

create table if not exists prompt_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_space_id uuid references project_spaces(id) on delete set null,
  name text not null,
  content text not null,
  description text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists prompt_templates_user_lower_name_idx
  on prompt_templates(user_id, lower(name));

create index if not exists prompt_templates_user_id_updated_at_idx
  on prompt_templates(user_id, updated_at desc);

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

alter table conversations
  add column if not exists project_space_id uuid references project_spaces(id) on delete set null;

alter table files
  add column if not exists project_space_id uuid references project_spaces(id) on delete set null;

alter table messages
  add column if not exists sources jsonb not null default '[]'::jsonb;

create index if not exists conversations_user_id_project_space_id_updated_at_idx
  on conversations(user_id, project_space_id, updated_at desc);

create index if not exists files_user_id_project_space_id_created_at_idx
  on files(user_id, project_space_id, created_at desc);

insert into project_spaces (user_id, name, description, is_default)
select users.id, 'General', '', true
from users
where not exists (
  select 1
  from project_spaces
  where project_spaces.user_id = users.id
    and project_spaces.is_default = true
);

update conversations
set project_space_id = project_spaces.id
from project_spaces
where conversations.user_id = project_spaces.user_id
  and project_spaces.is_default = true
  and conversations.project_space_id is null;

update files
set project_space_id = project_spaces.id
from project_spaces
where files.user_id = project_spaces.user_id
  and project_spaces.is_default = true
  and files.project_space_id is null;

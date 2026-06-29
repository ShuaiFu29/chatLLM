alter table conversations
  add column if not exists is_pinned boolean not null default false;

alter table conversations
  add column if not exists archived_at timestamptz;

create index if not exists conversations_user_id_project_space_archived_pinned_updated_idx
  on conversations(user_id, project_space_id, archived_at, is_pinned desc, updated_at desc);

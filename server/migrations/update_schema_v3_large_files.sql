-- Drop tables if they exist to reset schema (Cascade to remove dependent constraints/tables)
drop table if exists files cascade;

-- Create files table
create table if not exists files (
  id uuid default gen_random_uuid() primary key,
  user_id bigint not null, -- Changed from uuid to bigint to match users.id
  filename text not null,
  file_hash text not null,
  file_size bigint,
  file_type text,
  storage_path text,
  status text default 'uploading',
  progress int default 0,
  error_message text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Re-add file_id to documents (if it doesn't exist or needs recreating)
-- We use DO block to safely add column if missing
do $$ 
begin
    if not exists (select 1 from information_schema.columns where table_name = 'documents' and column_name = 'file_id') then
        alter table documents add column file_id uuid references files(id) on delete cascade;
    end if;
end $$;

-- Indexes
create index if not exists idx_files_hash on files(file_hash);
create index if not exists idx_files_user_id on files(user_id);
create index if not exists idx_documents_file_id on documents(file_id);

-- Disable RLS for now as Backend manages Auth and uses Anon Key
alter table files disable row level security;

-- Ensure documents RLS is handled (Disable if previously enabled by mistake, or ensure policies exist)
-- Since we are using custom auth backend, let's keep it simple and trust the backend.
alter table documents disable row level security;

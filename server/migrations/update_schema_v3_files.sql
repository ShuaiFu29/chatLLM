create table if not exists files (
  id uuid default gen_random_uuid() primary key,
  filename text not null,
  file_path text not null, -- Path in Supabase Storage
  file_type text,
  file_size bigint,
  status text default 'pending', -- pending, processing, completed, failed
  error_message text,
  user_id uuid not null,
  processed_chunks int default 0,
  total_chunks int default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- RLS policies
alter table files enable row level security;

create policy "Users can view their own files"
on files for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can insert their own files"
on files for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own files"
on files for update
to authenticated
using (auth.uid() = user_id);

create policy "Users can delete their own files"
on files for delete
to authenticated
using (auth.uid() = user_id);

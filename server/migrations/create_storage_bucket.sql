-- Create a storage bucket for documents if it doesn't exist
insert into storage.buckets (id, name, public)
values ('documents', 'documents', true)
on conflict (id) do nothing;

-- Set up security policies for the documents bucket
-- 1. Allow authenticated users to upload files
create policy "Authenticated users can upload documents"
on storage.objects for insert
to authenticated
with check ( bucket_id = 'documents' and auth.uid() = owner );

-- 2. Allow authenticated users to view their own files
create policy "Users can view their own documents"
on storage.objects for select
to authenticated
using ( bucket_id = 'documents' and auth.uid() = owner );

-- 3. Allow authenticated users to delete their own files
create policy "Users can delete their own documents"
on storage.objects for delete
to authenticated
using ( bucket_id = 'documents' and auth.uid() = owner );

-- Fix Storage Policies to allow server-side (anon) uploads

-- 1. Drop existing restrictive policies
DROP POLICY IF EXISTS "Authenticated users can upload avatars" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update avatars" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete avatars" ON storage.objects;

-- 2. Create permissive policies for the server (which uses Anon key)

-- Allow anyone (including anon server) to upload to avatars bucket
CREATE POLICY "Allow public uploads to avatars"
ON storage.objects FOR INSERT
WITH CHECK ( bucket_id = 'avatars' );

-- Allow anyone (including anon server) to update avatars
CREATE POLICY "Allow public updates to avatars"
ON storage.objects FOR UPDATE
USING ( bucket_id = 'avatars' );

-- Allow anyone (including anon server) to delete avatars
CREATE POLICY "Allow public deletes from avatars"
ON storage.objects FOR DELETE
USING ( bucket_id = 'avatars' );

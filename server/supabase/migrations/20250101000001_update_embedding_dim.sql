
-- Update embedding dimension to 1024 to match ZhipuAI embedding-2 model
ALTER TABLE documents 
ALTER COLUMN embedding TYPE vector(1024);

-- Optimization: Add indexes for performance

-- 1. Enable pgvector HNSW index for fast similarity search
-- Note: ivfflat is faster to build but requires retraining. hnsw is slower to build but better recall and incremental updates.
-- We use lists=100 for now, but for small datasets it doesn't matter much.
-- Actually, HNSW is generally preferred now.
CREATE INDEX IF NOT EXISTS documents_embedding_idx 
ON documents 
USING hnsw (embedding vector_cosine_ops);

-- 2. Indexes for Chat System
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id 
ON messages(conversation_id);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id 
ON conversations(user_id);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at 
ON conversations(updated_at DESC);

-- 3. Indexes for File System
CREATE INDEX IF NOT EXISTS idx_files_user_id 
ON files(user_id);

CREATE INDEX IF NOT EXISTS idx_files_status 
ON files(status); -- Helpful for the file queue polling

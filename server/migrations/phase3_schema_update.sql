-- Phase 3: Model Switching & Knowledge Base Enhancements
-- Run this in your Supabase SQL Editor

ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS model text DEFAULT 'deepseek-chat',
ADD COLUMN IF NOT EXISTS temperature float DEFAULT 0.7,
ADD COLUMN IF NOT EXISTS system_prompt text DEFAULT 'You are a helpful AI assistant.',
ADD COLUMN IF NOT EXISTS enable_rag boolean DEFAULT true;

-- Update existing rows to have default values (optional, as DEFAULT handles new rows)
UPDATE conversations SET model = 'deepseek-chat' WHERE model IS NULL;
UPDATE conversations SET temperature = 0.7 WHERE temperature IS NULL;
UPDATE conversations SET system_prompt = 'You are a helpful AI assistant.' WHERE system_prompt IS NULL;
UPDATE conversations SET enable_rag = true WHERE enable_rag IS NULL;

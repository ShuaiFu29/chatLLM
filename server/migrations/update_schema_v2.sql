-- Add settings column to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb;

-- Add comment to describe the settings structure
COMMENT ON COLUMN users.settings IS 'User preferences: { temperature, model, system_prompt }';

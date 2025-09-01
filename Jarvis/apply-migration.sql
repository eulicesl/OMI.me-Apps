-- Safe Migration for Jarvis Sessions Table
-- This migration adds a uid column without affecting existing data

-- Step 1: Add uid column if it doesn't exist
-- This is safe and won't error if column already exists
ALTER TABLE jarvis_sessions 
ADD COLUMN IF NOT EXISTS uid TEXT;

-- Step 2: Create index for better query performance
-- This helps when querying by uid
CREATE INDEX IF NOT EXISTS idx_jarvis_sessions_uid ON jarvis_sessions(uid);1

-- Step 3: Update existing records to set uid = session_id
-- This preserves the ability to link old sessions
UPDATE jarvis_sessions 
SET uid = session_id 
WHERE uid IS NULL;

-- Step 4: Verify the migration
-- You can run this to check the results
-- SELECT id, session_id, uid, created_at FROM jarvis_sessions LIMIT 5;
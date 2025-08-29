-- Add uid column to jarvis_sessions table to link sessions to users
ALTER TABLE jarvis_sessions 
ADD COLUMN IF NOT EXISTS uid TEXT;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_jarvis_sessions_uid ON jarvis_sessions(uid);

-- Update any existing sessions to use session_id as uid if needed
UPDATE jarvis_sessions 
SET uid = session_id 
WHERE uid IS NULL;
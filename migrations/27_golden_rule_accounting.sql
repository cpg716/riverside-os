-- Migration 27: Golden Rule Accounting (Weather & EOD Context)
-- Adds storage for environmental context and end-of-day staff annotations.

ALTER TABLE register_sessions ADD COLUMN IF NOT EXISTS weather_snapshot JSONB;
ALTER TABLE register_sessions ADD COLUMN IF NOT EXISTS closing_comments TEXT;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS weather_snapshot JSONB;

-- Index for reporting performance
CREATE INDEX IF NOT EXISTS idx_register_sessions_closed_at ON register_sessions(closed_at) WHERE (closed_at IS NOT NULL);

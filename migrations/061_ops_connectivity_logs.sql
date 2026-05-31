-- Migration 061: Add ops_connectivity_logs table and extend integration_alert_state status
-- Tracks changes in integration status transitions (GOOD -> CAUTION -> WARNING)

CREATE TABLE IF NOT EXISTS ops_connectivity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL,
    old_status TEXT NOT NULL,
    new_status TEXT NOT NULL,
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ops_connectivity_logs_created_at ON ops_connectivity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_connectivity_logs_source ON ops_connectivity_logs(source);

-- Extend integration_alert_state table with status column
ALTER TABLE integration_alert_state ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'healthy';

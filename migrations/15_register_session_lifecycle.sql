-- Register session lifecycle: status, cash adjustments (non-sale), Z-report snapshot

ALTER TABLE register_sessions
    ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'open';

ALTER TABLE register_sessions
    ADD COLUMN IF NOT EXISTS z_report_json JSONB;

UPDATE register_sessions
SET lifecycle_status = 'closed'
WHERE NOT is_open AND lifecycle_status = 'open';

ALTER TABLE register_sessions
    DROP CONSTRAINT IF EXISTS register_sessions_lifecycle_status_check;

ALTER TABLE register_sessions
    ADD CONSTRAINT register_sessions_lifecycle_status_check
        CHECK (lifecycle_status IN ('open', 'reconciling', 'closed'));

CREATE TABLE IF NOT EXISTS register_cash_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES register_sessions(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('paid_in', 'paid_out')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    category TEXT,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS register_cash_adjustments_session_idx
    ON register_cash_adjustments (session_id);

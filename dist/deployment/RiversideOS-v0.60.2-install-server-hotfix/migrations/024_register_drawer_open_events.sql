-- Audit manual cash drawer opens separately from cash paid-in/paid-out adjustments.

CREATE TABLE IF NOT EXISTS register_drawer_open_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES register_sessions(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id),
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS register_drawer_open_events_session_idx
    ON register_drawer_open_events (session_id, created_at DESC);

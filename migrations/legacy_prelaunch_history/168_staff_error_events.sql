-- Lightweight automated client error/toast event trail for Settings -> Bug reports.

CREATE TABLE IF NOT EXISTS staff_error_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    event_source TEXT NOT NULL DEFAULT 'client_toast',
    severity TEXT NOT NULL DEFAULT 'error',
    route TEXT,
    client_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    server_log_snapshot TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_staff_error_event_created_at
    ON staff_error_event (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_error_event_staff_created_at
    ON staff_error_event (staff_id, created_at DESC);

COMMENT ON TABLE staff_error_event IS 'Automated lightweight operational error events, primarily client error toasts, shown beside staff bug reports.';

-- Integration job health + staff PIN failure audit for notification generators.

CREATE TABLE integration_alert_state (
    source TEXT PRIMARY KEY,
    last_failure_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    detail TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO integration_alert_state (source) VALUES
    ('qbo_token_refresh'),
    ('weather_finalize')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE integration_alert_state IS 'Last success/failure per background integration (QBO token refresh, weather finalize) for admin notifications.';

CREATE TABLE staff_auth_failure_event (
    id BIGSERIAL PRIMARY KEY,
    staff_id UUID NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    failure_kind TEXT NOT NULL DEFAULT 'pin_mismatch',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_staff_auth_failure_created ON staff_auth_failure_event (created_at DESC);
CREATE INDEX idx_staff_auth_failure_staff_time ON staff_auth_failure_event (staff_id, created_at DESC);

COMMENT ON TABLE staff_auth_failure_event IS 'Failed PIN verification attempts (staff_id known) for security digest notifications.';

-- Multiple concurrent open registers: physical lane (Register #1, #2, …) + attach token for staff.

ALTER TABLE register_sessions
    ADD COLUMN IF NOT EXISTS register_lane SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE register_sessions
    DROP CONSTRAINT IF EXISTS register_sessions_register_lane_check;

ALTER TABLE register_sessions
    ADD CONSTRAINT register_sessions_register_lane_check
    CHECK (register_lane >= 1 AND register_lane <= 99);

DROP INDEX IF EXISTS register_sessions_open_lane_uidx;

CREATE UNIQUE INDEX register_sessions_open_lane_uidx
    ON register_sessions (register_lane)
    WHERE is_open = true;

COMMENT ON COLUMN register_sessions.register_lane IS 'Physical register number (1–99). Unique among open sessions (is_open=true).';

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'register.session_attach', true),
    ('salesperson', 'register.session_attach', true),
    ('sales_support', 'register.session_attach', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

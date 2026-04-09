-- App-wide notification center: canonical notifications + per-staff inbox + action audit.

CREATE TABLE IF NOT EXISTS app_notification (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    deep_link JSONB NOT NULL DEFAULT '{}'::jsonb,
    source TEXT NOT NULL DEFAULT 'system',
    audience_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS app_notification_dedupe_key_uq
    ON app_notification (dedupe_key)
    WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_notification_created ON app_notification (created_at DESC);

CREATE TABLE IF NOT EXISTS staff_notification (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL REFERENCES app_notification (id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    compact_summary TEXT,
    UNIQUE (notification_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_notification_staff_created
    ON staff_notification (staff_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_notification_staff_inbox
    ON staff_notification (staff_id)
    WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS staff_notification_action (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_notification_id UUID NOT NULL REFERENCES staff_notification (id) ON DELETE CASCADE,
    actor_staff_id UUID NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_staff_notification_action_sn
    ON staff_notification_action (staff_notification_id, created_at DESC);

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'notifications.view', true),
    ('admin', 'notifications.broadcast', true),
    ('salesperson', 'notifications.view', true),
    ('sales_support', 'notifications.view', true)
ON CONFLICT (role, permission_key) DO NOTHING;

COMMENT ON TABLE app_notification IS 'Canonical notification payload; fan-out to staff_notification per recipient.';
COMMENT ON COLUMN app_notification.dedupe_key IS 'Optional unique key to suppress duplicate generator emissions.';
COMMENT ON TABLE staff_notification IS 'Per-staff inbox row; archived_at set by retention job (~30d).';

-- Counterpoint staging inbox + store_settings.counterpoint_config (GUI toggle for bridge).
-- Depends on: 84_counterpoint_sync_extended.sql, 01 store_settings.

ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS counterpoint_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN store_settings.counterpoint_config IS
    'Counterpoint integration: e.g. {"staging_enabled": true} — when true, bridge POSTs to /api/sync/counterpoint/staging for staff Apply.';

CREATE TABLE IF NOT EXISTS counterpoint_staging_batch (
    id                 BIGSERIAL PRIMARY KEY,
    entity             TEXT NOT NULL,
    payload            JSONB NOT NULL,
    row_count          INTEGER NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'applied', 'discarded', 'failed')),
    apply_error        TEXT,
    bridge_version     TEXT,
    bridge_hostname    TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_at         TIMESTAMPTZ,
    applied_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS counterpoint_staging_batch_status_created_idx
    ON counterpoint_staging_batch (status, created_at DESC);

INSERT INTO ros_schema_migrations (version) VALUES ('95_counterpoint_staging_gui.sql')
ON CONFLICT (version) DO NOTHING;

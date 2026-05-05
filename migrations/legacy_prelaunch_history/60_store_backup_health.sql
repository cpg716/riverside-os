-- Tracks last local/cloud backup outcomes for admin notifications (failed backup, failed cloud export, overdue).
CREATE TABLE store_backup_health (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    CONSTRAINT store_backup_health_singleton CHECK (id = 1),
    last_local_success_at TIMESTAMPTZ,
    last_local_failure_at TIMESTAMPTZ,
    last_local_failure_detail TEXT,
    last_cloud_success_at TIMESTAMPTZ,
    last_cloud_failure_at TIMESTAMPTZ,
    last_cloud_failure_detail TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO store_backup_health (id) VALUES (1);

COMMENT ON TABLE store_backup_health IS 'Singleton row (id=1): last backup success/failure timestamps for notification generators.';

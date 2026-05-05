-- Persistent record of applied repo migrations (filenames under migrations/).
-- Populated automatically by scripts/apply-migrations-docker.sh after each successful file.
-- Use scripts/migration-status-docker.sh to compare ledger vs schema probes.

CREATE TABLE IF NOT EXISTS ros_schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ros_schema_migrations_applied_at
    ON ros_schema_migrations (applied_at DESC);

COMMENT ON TABLE ros_schema_migrations IS
    'One row per applied migrations/NN_name.sql file (basename = version). Not used by sqlx; ops/CI only.';

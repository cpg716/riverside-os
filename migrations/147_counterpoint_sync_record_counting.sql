-- Migration 147: Counterpoint Sync Record Counting
-- Adds visibility into how many records were processed during the last sync run.

ALTER TABLE counterpoint_sync_runs
    ADD COLUMN IF NOT EXISTS records_processed INTEGER;

INSERT INTO ros_schema_migrations (version) VALUES ('147_counterpoint_sync_record_counting.sql')
ON CONFLICT (version) DO NOTHING;

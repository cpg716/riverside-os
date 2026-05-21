-- Enable WAL archiving for point-in-time recovery capability
-- This migration configures PostgreSQL for continuous WAL archiving

\set ON_ERROR_STOP on

-- Enable WAL archiving in postgresql.conf (this would need to be applied to the actual config)
-- These settings are documented here for deployment scripts:

-- wal_level = replica
-- archive_mode = on
-- archive_command = 'cp %p /var/lib/postgresql/wal_archive/%f'
-- archive_timeout = 300  -- Archive at least every 5 minutes

-- Create a table to track WAL archive status
CREATE TABLE IF NOT EXISTS wal_archive_status (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    archive_directory text NOT NULL,
    last_archive_at timestamptz,
    last_archive_file text,
    archive_count_today bigint DEFAULT 0,
    archive_size_mb bigint DEFAULT 0,
    status text DEFAULT 'unknown', -- 'active', 'failed', 'disabled'
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Create index for monitoring
CREATE INDEX IF NOT EXISTS idx_wal_archive_status_updated_at 
ON wal_archive_status(updated_at);

-- Insert initial status row
INSERT INTO wal_archive_status (
    archive_directory,
    status,
    created_at,
    updated_at
) VALUES (
    '/var/lib/postgresql/wal_archive',
    'unknown',
    now(),
    now()
) ON CONFLICT DO NOTHING;

-- Create function to update archive status
CREATE OR REPLACE FUNCTION update_wal_archive_status(
    p_status text,
    p_error_message text DEFAULT NULL
) RETURNS void AS $$
BEGIN
    UPDATE wal_archive_status 
    SET 
        status = p_status,
        error_message = p_error_message,
        updated_at = now()
    WHERE id = (SELECT id FROM wal_archive_status LIMIT 1);
END;
$$ LANGUAGE plpgsql;

-- Create function to record successful archive
CREATE OR REPLACE FUNCTION record_wal_archive_success(
    p_archive_file text,
    p_file_size_mb bigint
) RETURNS void AS $$
BEGIN
    UPDATE wal_archive_status 
    SET 
        status = 'active',
        last_archive_at = now(),
        last_archive_file = p_archive_file,
        archive_count_today = CASE 
            WHEN date(updated_at) = date(now()) THEN archive_count_today + 1
            ELSE 1
        END,
        archive_size_mb = archive_size_mb + p_file_size_mb,
        error_message = NULL,
        updated_at = now()
    WHERE id = (SELECT id FROM wal_archive_status LIMIT 1);
END;
$$ LANGUAGE plpgsql;

-- Create view for monitoring WAL archive health
CREATE OR REPLACE VIEW wal_archive_health AS
SELECT 
    id,
    archive_directory,
    last_archive_at,
    last_archive_file,
    archive_count_today,
    archive_size_mb,
    status,
    error_message,
    CASE 
        WHEN status = 'active' AND last_archive_at > now() - interval '10 minutes' THEN 'healthy'
        WHEN status = 'active' AND last_archive_at > now() - interval '30 minutes' THEN 'warning'
        WHEN status = 'failed' THEN 'critical'
        ELSE 'unknown'
    END AS health_status,
    EXTRACT(epoch FROM (now() - last_archive_at))::bigint AS seconds_since_last_archive,
    created_at,
    updated_at
FROM wal_archive_status
ORDER BY updated_at DESC
LIMIT 1;

COMMENT ON TABLE wal_archive_status IS 'Tracks WAL archiving status and metrics for point-in-time recovery monitoring.';
COMMENT ON VIEW wal_archive_health IS 'WAL archive health monitoring view for alerting and dashboard display.';
COMMENT ON FUNCTION update_wal_archive_status IS 'Update WAL archive status (used by monitoring scripts).';
COMMENT ON FUNCTION record_wal_archive_success IS 'Record successful WAL archive operation (used by archive_command wrapper).';

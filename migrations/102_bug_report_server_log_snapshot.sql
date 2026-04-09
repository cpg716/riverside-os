-- Point-in-time Riverside server log buffer snapshot at bug submission (for triage).

ALTER TABLE staff_bug_report
    ADD COLUMN IF NOT EXISTS server_log_snapshot TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN staff_bug_report.server_log_snapshot IS 'Recent in-process tracing lines from the API server when the report was submitted; not a full log file.';

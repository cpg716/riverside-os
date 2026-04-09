-- ============================================================================
-- OPTIONAL. You usually do NOT need this file.
--
-- The full schema (including Z-report columns) lives in 01_initial_schema.sql.
-- If you created your database by running 01_initial_schema.sql from this repo,
-- skip this file — those columns already exist.
--
-- Run this ONLY if Postgres errors on "Close Shift" with unknown column
-- (e.g. discrepancy / closing_notes). Safe to run anyway: IF NOT EXISTS.
-- ============================================================================
ALTER TABLE register_sessions
    ADD COLUMN IF NOT EXISTS discrepancy NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS closing_notes TEXT,
    ADD COLUMN IF NOT EXISTS actual_cash NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS expected_cash NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

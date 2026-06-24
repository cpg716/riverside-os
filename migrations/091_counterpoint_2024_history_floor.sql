-- Align Counterpoint import-run defaults with the go-live history floor.
ALTER TABLE IF EXISTS counterpoint_import_runs
    ALTER COLUMN history_start SET DEFAULT DATE '2024-01-01';

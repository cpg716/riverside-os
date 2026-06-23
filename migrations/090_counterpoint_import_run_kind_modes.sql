-- Keep Counterpoint import run-kind constraints aligned with the live Bridge/API.
-- Migration 081 used the old rehearsal wording. The current workflow is live
-- ingest into ROS with landed proof, exception repair, finalization, and reset.

ALTER TABLE counterpoint_import_runs
    DROP CONSTRAINT IF EXISTS counterpoint_import_runs_run_kind_check;

UPDATE counterpoint_import_runs
SET run_kind = 'full_import'
WHERE run_kind IN ('rehearsal', 'full_rehearsal');

ALTER TABLE counterpoint_import_runs
    ADD CONSTRAINT counterpoint_import_runs_run_kind_check
    CHECK (
        run_kind IN (
            'preflight',
            'full_import',
            'fix_rerun',
            'incremental_update',
            'go_live'
        )
    );

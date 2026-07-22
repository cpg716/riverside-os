-- Keep archive verification evidence distinct from the legacy scheduler-success
-- timestamp. Existing rows are intentionally not backfilled: readiness becomes
-- healthy only after this build creates and verifies a new PostgreSQL archive.

ALTER TABLE public.store_backup_health
    ADD COLUMN IF NOT EXISTS last_local_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_local_verified_filename TEXT,
    ADD COLUMN IF NOT EXISTS last_local_verification_method TEXT;

COMMENT ON COLUMN public.store_backup_health.last_local_verified_at IS
    'Most recent local backup whose PostgreSQL custom-format header and pg_restore catalog were successfully verified.';

COMMENT ON COLUMN public.store_backup_health.last_local_verified_filename IS
    'Final local catalog filename for the most recent verified backup archive.';

COMMENT ON COLUMN public.store_backup_health.last_local_verification_method IS
    'Verification method used for the most recent verified backup; currently pg_restore_catalog.';

-- Bind verified-backup readiness evidence to the exact archive bytes that were
-- catalog-verified. Existing evidence is intentionally not backfilled: a new
-- verified backup must establish the size and SHA-256 identity.

ALTER TABLE public.store_backup_health
    ADD COLUMN IF NOT EXISTS last_local_verified_size_bytes BIGINT,
    ADD COLUMN IF NOT EXISTS last_local_verified_sha256 TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'store_backup_health_verified_size_positive_chk'
          AND conrelid = 'public.store_backup_health'::regclass
    ) THEN
        ALTER TABLE public.store_backup_health
            ADD CONSTRAINT store_backup_health_verified_size_positive_chk
            CHECK (
                last_local_verified_size_bytes IS NULL
                OR last_local_verified_size_bytes > 0
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'store_backup_health_verified_sha256_chk'
          AND conrelid = 'public.store_backup_health'::regclass
    ) THEN
        ALTER TABLE public.store_backup_health
            ADD CONSTRAINT store_backup_health_verified_sha256_chk
            CHECK (
                last_local_verified_sha256 IS NULL
                OR last_local_verified_sha256 ~ '^[0-9a-f]{64}$'
            );
    END IF;
END
$$;

COMMENT ON COLUMN public.store_backup_health.last_local_verified_size_bytes IS
    'Byte length of the exact local archive recorded as the most recent verified backup.';

COMMENT ON COLUMN public.store_backup_health.last_local_verified_sha256 IS
    'Lowercase SHA-256 of the exact local archive recorded as the most recent verified backup.';

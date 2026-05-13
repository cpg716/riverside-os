-- Add operator-facing Counterpoint staging observability metadata.
ALTER TABLE counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS replay_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS last_replayed_at TIMESTAMPTZ;

ALTER TABLE counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS payload_fingerprint TEXT;

ALTER TABLE counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ;

ALTER TABLE counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS recovered_by_staff_id UUID;

ALTER TABLE counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS recovery_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'counterpoint_staging_batch_recovered_by_staff_id_fkey'
  ) THEN
    ALTER TABLE counterpoint_staging_batch
    ADD CONSTRAINT counterpoint_staging_batch_recovered_by_staff_id_fkey
    FOREIGN KEY (recovered_by_staff_id) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

UPDATE counterpoint_staging_batch
SET payload_fingerprint = md5(payload::text)
WHERE payload_fingerprint IS NULL;

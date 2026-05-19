-- Track durable Counterpoint staging apply ownership so interrupted claims
-- can be surfaced and safely marked failed without replaying payloads.
ALTER TABLE counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS apply_started_at TIMESTAMPTZ;

ALTER TABLE counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS apply_claimed_by_staff_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'counterpoint_staging_batch_apply_claimed_by_staff_id_fkey'
  ) THEN
    ALTER TABLE counterpoint_staging_batch
    ADD CONSTRAINT counterpoint_staging_batch_apply_claimed_by_staff_id_fkey
    FOREIGN KEY (apply_claimed_by_staff_id) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

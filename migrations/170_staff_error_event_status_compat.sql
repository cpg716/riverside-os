-- Ensure staff_error_event has triage status fields even when older/partial migrations
-- were applied before migration 169.

ALTER TABLE staff_error_event
    ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE staff_error_event
SET status = 'pending'
WHERE status IS NULL OR status = '';

DO $$
BEGIN
    ALTER TABLE staff_error_event
        ALTER COLUMN status SET DEFAULT 'pending';

    ALTER TABLE staff_error_event
        ALTER COLUMN status SET NOT NULL;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'staff_error_event'
      AND c.conname = 'staff_error_event_status_check'
  ) THEN
    ALTER TABLE staff_error_event
      ADD CONSTRAINT staff_error_event_status_check
      CHECK (LOWER(status) IN ('pending', 'complete', 'archived'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_staff_error_event_status
    ON staff_error_event (status);

CREATE INDEX IF NOT EXISTS idx_staff_error_event_status_created_at
    ON staff_error_event (status, created_at DESC);

COMMENT ON COLUMN staff_error_event.status IS
    'Automated error-event triage state used by staff reporting workflows.';

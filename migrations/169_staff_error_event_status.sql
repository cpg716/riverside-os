-- Add triage status for automated staff error events.

ALTER TABLE staff_error_event
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

UPDATE staff_error_event
SET status = 'pending'
WHERE status IS NULL OR status = '';

ALTER TABLE staff_error_event
    ADD CONSTRAINT IF NOT EXISTS staff_error_event_status_check
    CHECK (LOWER(status) IN ('pending', 'complete', 'archived'));

CREATE INDEX IF NOT EXISTS idx_staff_error_event_status
    ON staff_error_event (status);

CREATE INDEX IF NOT EXISTS idx_staff_error_event_status_created_at
    ON staff_error_event (status, created_at DESC);

COMMENT ON COLUMN staff_error_event.status IS
    'Automated error-event triage state used by staff reporting workflows.';

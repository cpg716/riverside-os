-- QBO integration hardening: webhook event log and improved sync tracking

-- Log incoming QBO webhook events for auditability
CREATE TABLE IF NOT EXISTS qbo_webhook_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL PRIMARY KEY,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    processed boolean NOT NULL DEFAULT FALSE,
    received_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_qbo_webhook_events_received_at
    ON qbo_webhook_events (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_qbo_webhook_events_unprocessed
    ON qbo_webhook_events (processed, received_at)
    WHERE processed = FALSE;

COMMENT ON TABLE qbo_webhook_events IS 'Audit log for Intuit QBO webhook deliveries.';

-- Add nullable approved_by_staff_id to qbo_sync_logs for stronger audit trail
ALTER TABLE qbo_sync_logs
    ADD COLUMN IF NOT EXISTS approved_by_staff_id uuid REFERENCES staff(id);

-- Add nullable approved_at for precise approval timing
ALTER TABLE qbo_sync_logs
    ADD COLUMN IF NOT EXISTS approved_at timestamp with time zone;

COMMENT ON COLUMN qbo_sync_logs.approved_by_staff_id IS 'Staff member who approved this staging row before sync.';
COMMENT ON COLUMN qbo_sync_logs.approved_at IS 'Timestamp when this staging row was approved.';

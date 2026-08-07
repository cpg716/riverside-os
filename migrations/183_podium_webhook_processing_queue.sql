-- Make Podium webhook acknowledgement durable before asynchronous CRM ingest.

ALTER TABLE podium_webhook_delivery
    ADD COLUMN IF NOT EXISTS raw_payload JSONB,
    ADD COLUMN IF NOT EXISTS processing_status TEXT,
    ADD COLUMN IF NOT EXISTS processing_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Historical rows predate durable payload storage and cannot be replayed.
UPDATE podium_webhook_delivery
SET processing_status = 'processed',
    processed_at = COALESCE(processed_at, received_at)
WHERE processing_status IS NULL;

ALTER TABLE podium_webhook_delivery
    ALTER COLUMN processing_status SET DEFAULT 'pending',
    ALTER COLUMN processing_status SET NOT NULL;

ALTER TABLE podium_webhook_delivery
    DROP CONSTRAINT IF EXISTS podium_webhook_delivery_processing_status_chk;

ALTER TABLE podium_webhook_delivery
    ADD CONSTRAINT podium_webhook_delivery_processing_status_chk
    CHECK (processing_status IN ('pending', 'processing', 'processed', 'skipped', 'failed'));

CREATE INDEX IF NOT EXISTS idx_podium_webhook_delivery_pending
    ON podium_webhook_delivery (next_attempt_at, received_at)
    WHERE processing_status IN ('pending', 'processing');

COMMENT ON COLUMN podium_webhook_delivery.raw_payload IS 'Verified Podium JSON retained for durable asynchronous CRM ingest.';
COMMENT ON COLUMN podium_webhook_delivery.processing_status IS 'Durable ingest lifecycle: pending, processing, processed, skipped, or failed.';

ALTER TABLE customer_notification_queue
    DROP CONSTRAINT IF EXISTS customer_notification_queue_delivery_method_check;

ALTER TABLE customer_notification_queue
    ADD CONSTRAINT customer_notification_queue_delivery_method_check
    CHECK (delivery_method IN ('sms', 'email', 'both', 'none'));

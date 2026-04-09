-- Podium webhook idempotency ledger + operational SMS consent on customers.

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS transactional_sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve prior behavior: rows that already opted into marketing SMS also receive operational texts.
UPDATE customers
SET transactional_sms_opt_in = TRUE
WHERE marketing_sms_opt_in = TRUE
  AND transactional_sms_opt_in = FALSE;

CREATE TABLE IF NOT EXISTS podium_webhook_delivery (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    idempotency_key TEXT NOT NULL,
    payload_sha256_hex TEXT NOT NULL,
    CONSTRAINT podium_webhook_delivery_idem_uq UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_podium_webhook_delivery_received
    ON podium_webhook_delivery (received_at DESC);

COMMENT ON TABLE podium_webhook_delivery IS 'Inbound Podium webhook deliveries; idempotency_key prevents duplicate processing on retries.';
COMMENT ON COLUMN customers.transactional_sms_opt_in IS 'Consent for operational SMS (pickup/alteration ready, etc.); OR with marketing_sms_opt_in in messaging gate.';

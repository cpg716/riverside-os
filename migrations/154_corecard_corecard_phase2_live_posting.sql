-- Phase 2 live CoreCard / CoreCredit posting state for unified RMS Charge.
-- Adds durable host posting fields to RMS records plus an append-style posting event log
-- for purchases, payments, refunds, reversals, and retry/idempotency handling.

ALTER TABLE pos_rms_charge_record
    ADD COLUMN IF NOT EXISTS external_transaction_id TEXT,
    ADD COLUMN IF NOT EXISTS external_auth_code TEXT,
    ADD COLUMN IF NOT EXISTS posting_status TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN IF NOT EXISTS posting_error_code TEXT,
    ADD COLUMN IF NOT EXISTS posting_error_message TEXT,
    ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS external_transaction_type TEXT,
    ADD COLUMN IF NOT EXISTS host_reference TEXT,
    ADD COLUMN IF NOT EXISTS host_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS request_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS response_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_pos_rms_charge_record_posting_status_created
    ON pos_rms_charge_record (posting_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_rms_charge_record_external_tx
    ON pos_rms_charge_record (external_transaction_id)
    WHERE external_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pos_rms_charge_record_idempotency_key
    ON pos_rms_charge_record (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN pos_rms_charge_record.posting_status IS
    'Live CoreCard host lifecycle for RMS Charge rows: legacy, pending, posted, failed, reversed, refunded.';

COMMENT ON COLUMN pos_rms_charge_record.host_metadata_json IS
    'Redacted host reference/status metadata suitable for UI, receipt rendering, and QBO-safe audit review.';

CREATE TABLE IF NOT EXISTS corecard_posting_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    posting_status TEXT NOT NULL DEFAULT 'pending',
    retryable BOOLEAN NOT NULL DEFAULT false,
    customer_id UUID REFERENCES customers (id) ON DELETE SET NULL,
    transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
    payment_transaction_id UUID REFERENCES payment_transactions (id) ON DELETE SET NULL,
    pos_rms_charge_record_id UUID REFERENCES pos_rms_charge_record (id) ON DELETE SET NULL,
    linked_corecredit_customer_id TEXT,
    linked_corecredit_account_id TEXT,
    linked_corecredit_card_id TEXT,
    program_code TEXT,
    amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    external_transaction_id TEXT,
    external_auth_code TEXT,
    external_transaction_type TEXT,
    host_reference TEXT,
    posting_error_code TEXT,
    posting_error_message TEXT,
    request_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    host_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    posted_at TIMESTAMPTZ,
    reversed_at TIMESTAMPTZ,
    refunded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_corecard_posting_event_idempotency_key
    ON corecard_posting_event (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_corecard_posting_event_transaction
    ON corecard_posting_event (transaction_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_corecard_posting_event_account
    ON corecard_posting_event (linked_corecredit_account_id, created_at DESC)
    WHERE linked_corecredit_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_corecard_posting_event_status
    ON corecard_posting_event (posting_status, operation_type, created_at DESC);

COMMENT ON TABLE corecard_posting_event IS
    'Append-style CoreCard host posting lifecycle log. Stores only redacted request/response snapshots and masked/minimal host references.';

COMMENT ON COLUMN corecard_posting_event.operation_type IS
    'purchase, payment, refund, or reversal.';

UPDATE pos_rms_charge_record
SET
    posting_status = CASE
        WHEN posting_status IS NULL OR btrim(posting_status) = '' THEN 'legacy'
        ELSE posting_status
    END,
    external_transaction_type = COALESCE(
        NULLIF(btrim(external_transaction_type), ''),
        CASE
            WHEN record_kind = 'charge' THEN 'purchase'
            WHEN record_kind = 'payment' THEN 'payment'
            ELSE NULL
        END
    )
WHERE
    posting_status IS NULL
    OR btrim(posting_status) = ''
    OR external_transaction_type IS NULL
    OR btrim(external_transaction_type) = '';

INSERT INTO ledger_mappings (internal_key, internal_description, qbo_account_id)
VALUES (
    'RMS_CHARGE_FINANCING_CLEARING',
    'Unified RMS Charge financed purchase clearing account for live CoreCard posting.',
    NULL
)
ON CONFLICT (internal_key) DO NOTHING;

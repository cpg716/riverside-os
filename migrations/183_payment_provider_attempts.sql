-- Provider-neutral payment attempt foundation.
-- This is an audit/control table for future terminal providers, not the payment ledger.

CREATE TABLE IF NOT EXISTS payment_provider_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    amount_cents BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    register_session_id UUID REFERENCES register_sessions (id) ON DELETE SET NULL,
    staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    device_id TEXT,
    terminal_id TEXT,
    idempotency_key TEXT NOT NULL,
    provider_payment_id TEXT,
    provider_transaction_id TEXT,
    error_code TEXT,
    error_message TEXT,
    raw_audit_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT payment_provider_attempts_provider_chk
        CHECK (btrim(provider) <> ''),
    CONSTRAINT payment_provider_attempts_status_chk
        CHECK (status IN ('pending', 'approved', 'captured', 'canceled', 'failed', 'expired')),
    CONSTRAINT payment_provider_attempts_amount_cents_chk
        CHECK (amount_cents >= 0),
    CONSTRAINT payment_provider_attempts_currency_chk
        CHECK (currency ~ '^[a-z]{3}$'),
    CONSTRAINT payment_provider_attempts_idempotency_key_chk
        CHECK (btrim(idempotency_key) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_provider_attempts_provider_idempotency
    ON payment_provider_attempts (provider, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_provider_attempts_active_device
    ON payment_provider_attempts (provider, COALESCE(terminal_id, device_id))
    WHERE status = 'pending'
      AND COALESCE(terminal_id, device_id) IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_provider_status_created
    ON payment_provider_attempts (provider, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_register_created
    ON payment_provider_attempts (register_session_id, created_at DESC)
    WHERE register_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_staff_created
    ON payment_provider_attempts (staff_id, created_at DESC)
    WHERE staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_terminal_created
    ON payment_provider_attempts (provider, terminal_id, created_at DESC)
    WHERE terminal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_device_created
    ON payment_provider_attempts (provider, device_id, created_at DESC)
    WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_provider_payment
    ON payment_provider_attempts (provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

DROP TRIGGER IF EXISTS trigger_payment_provider_attempts_updated_at
    ON payment_provider_attempts;
CREATE TRIGGER trigger_payment_provider_attempts_updated_at
BEFORE UPDATE ON payment_provider_attempts
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

COMMENT ON TABLE payment_provider_attempts IS
    'Provider-neutral terminal/payment attempt audit table. Attempts track pending/approved/canceled provider control flow and are not payment ledger rows.';
COMMENT ON COLUMN payment_provider_attempts.provider IS
    'Payment provider key such as stripe or future processor adapters.';
COMMENT ON COLUMN payment_provider_attempts.status IS
    'Attempt lifecycle: pending, approved, captured, canceled, failed, or expired.';
COMMENT ON COLUMN payment_provider_attempts.amount_cents IS
    'Requested attempt amount in minor currency units.';
COMMENT ON COLUMN payment_provider_attempts.idempotency_key IS
    'Client/server replay guard scoped uniquely per provider.';
COMMENT ON COLUMN payment_provider_attempts.raw_audit_reference IS
    'Redacted external audit/log reference only; do not store raw cardholder data or full provider payloads here.';

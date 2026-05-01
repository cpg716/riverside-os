-- Online store Phase 3: provider-neutral web checkout sessions.

CREATE TABLE IF NOT EXISTS store_checkout_session (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    guest_cart_id UUID REFERENCES store_guest_cart(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    contact JSONB NOT NULL DEFAULT '{}'::jsonb,
    fulfillment_method order_fulfillment_method NOT NULL DEFAULT 'pickup',
    ship_to JSONB,
    shipping_rate_quote_id UUID,
    lines_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
    coupon_id UUID REFERENCES store_coupons(id) ON DELETE SET NULL,
    coupon_code TEXT,
    coupon_snapshot JSONB,
    subtotal_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
    discount_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
    tax_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
    shipping_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
    selected_provider TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    idempotency_key TEXT NOT NULL,
    finalized_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '45 minutes'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT store_checkout_session_status_chk
        CHECK (status IN ('draft', 'payment_pending', 'paid', 'failed', 'expired', 'cancelled')),
    CONSTRAINT store_checkout_session_provider_chk
        CHECK (selected_provider IS NULL OR selected_provider IN ('stripe', 'helcim')),
    CONSTRAINT store_checkout_session_totals_chk
        CHECK (subtotal_usd >= 0 AND discount_usd >= 0 AND tax_usd >= 0 AND shipping_usd >= 0 AND total_usd >= 0),
    CONSTRAINT store_checkout_session_idempotency_key_chk
        CHECK (btrim(idempotency_key) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS store_checkout_session_idempotency_uidx
    ON store_checkout_session(idempotency_key);

CREATE INDEX IF NOT EXISTS store_checkout_session_status_created_idx
    ON store_checkout_session(status, created_at DESC);

CREATE INDEX IF NOT EXISTS store_checkout_session_finalized_idx
    ON store_checkout_session(finalized_transaction_id)
    WHERE finalized_transaction_id IS NOT NULL;

DROP TRIGGER IF EXISTS trigger_store_checkout_session_updated_at
    ON store_checkout_session;
CREATE TRIGGER trigger_store_checkout_session_updated_at
BEFORE UPDATE ON store_checkout_session
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

CREATE TABLE IF NOT EXISTS store_checkout_payment_attempt (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    checkout_session_id UUID NOT NULL REFERENCES store_checkout_session(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    amount_cents BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    provider_payment_id TEXT,
    provider_transaction_id TEXT,
    provider_status TEXT,
    client_secret TEXT,
    hosted_payment_url TEXT,
    error_code TEXT,
    error_message TEXT,
    raw_audit_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT store_checkout_payment_attempt_provider_chk
        CHECK (provider IN ('stripe', 'helcim')),
    CONSTRAINT store_checkout_payment_attempt_status_chk
        CHECK (status IN ('pending', 'requires_action', 'approved', 'captured', 'canceled', 'failed', 'expired')),
    CONSTRAINT store_checkout_payment_attempt_amount_chk
        CHECK (amount_cents >= 0),
    CONSTRAINT store_checkout_payment_attempt_currency_chk
        CHECK (currency ~ '^[a-z]{3}$')
);

CREATE INDEX IF NOT EXISTS store_checkout_payment_attempt_session_idx
    ON store_checkout_payment_attempt(checkout_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS store_checkout_payment_attempt_provider_payment_idx
    ON store_checkout_payment_attempt(provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

DROP TRIGGER IF EXISTS trigger_store_checkout_payment_attempt_updated_at
    ON store_checkout_payment_attempt;
CREATE TRIGGER trigger_store_checkout_payment_attempt_updated_at
BEFORE UPDATE ON store_checkout_payment_attempt
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

COMMENT ON TABLE store_checkout_session IS
    'Public storefront checkout session. ROS owns pricing, tax, shipping, coupon snapshots, provider choice, and finalization.';
COMMENT ON TABLE store_checkout_payment_attempt IS
    'Provider-neutral web checkout payment attempt table for Stripe and Helcim adapters.';

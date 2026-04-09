-- Customer-held party deposits (distinct from store credit): credits from wedding group splits
-- when the beneficiary has no open order yet; redeemable on a later checkout.

CREATE TABLE IF NOT EXISTS customer_open_deposit_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
    balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_open_deposit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES customer_open_deposit_accounts(id) ON DELETE CASCADE,
    amount NUMERIC(14, 2) NOT NULL,
    balance_after NUMERIC(14, 2) NOT NULL,
    reason TEXT NOT NULL,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    payer_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    payer_display_name TEXT,
    wedding_party_id UUID REFERENCES wedding_parties(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_open_deposit_ledger_account
    ON customer_open_deposit_ledger (account_id, created_at DESC);

COMMENT ON TABLE customer_open_deposit_accounts IS
    'Prepaid deposits held for a customer (e.g. wedding party split) redeemable on checkout via payment_method open_deposit.';

-- Migration 129: Stripe High-Level Integration Prep
-- Adds merchant fee tracking, Stripe customer vaulting, and extended payment metadata.

-- 1. Add Stripe Customer ID for vaulting
ALTER TABLE customers ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_customers_stripe_customer_id ON customers(stripe_customer_id);

-- 2. Add merchant fee tracking to payment transactions
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS merchant_fee NUMERIC(12, 2) DEFAULT 0.00;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS net_amount NUMERIC(12, 2) DEFAULT 0.00;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS stripe_fee_basis_points INTEGER; -- basis points (e.g. 290 for 2.9%)
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS stripe_fee_fixed_cents INTEGER;  -- fixed cents (e.g. 30 for $0.30)

-- 3. Add card metadata to transactions (last 4, brand)
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS card_brand VARCHAR(50);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS card_last4 VARCHAR(4);

-- 4. Registry for Stripe Webhooks (idempotency)
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    id VARCHAR(255) PRIMARY KEY, -- Stripe event ID
    event_type VARCHAR(100) NOT NULL,
    processed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5. Update reporting views to include net amounts (if they exist)
-- Note: 106_reporting_order_recognition used materialized views or tables, 
-- but we'll add logic to the raw table for now.

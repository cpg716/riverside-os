-- Migration 131: Stripe Vaulting & Credits
-- Stores Stripe PaymentMethod IDs and metadata for saved customer cards.

CREATE TABLE IF NOT EXISTS customer_vaulted_payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    stripe_payment_method_id VARCHAR(255) NOT NULL,
    brand VARCHAR(50) NOT NULL,
    last4 VARCHAR(4) NOT NULL,
    exp_month INTEGER NOT NULL,
    exp_year INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    -- Ensure we don't duplicate the same card for the same customer
    UNIQUE(customer_id, stripe_payment_method_id)
);

-- Index for quick lookup when starting a checkout for a customer
CREATE INDEX IF NOT EXISTS idx_customer_vaulted_pm_customer_id ON customer_vaulted_payment_methods(customer_id);

-- Add a comment for documentation
COMMENT ON TABLE customer_vaulted_payment_methods IS 'Stores reference metadata for vaulted cards in Stripe. Only stores non-sensitive indicators (last4, brand) to maintain PCI compliance.';

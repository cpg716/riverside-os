-- Provider-neutral payment metadata foundation.
-- Stripe remains the current/default provider; existing Stripe fields are preserved.

ALTER TABLE payment_transactions
    ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50),
    ADD COLUMN IF NOT EXISTS provider_payment_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS provider_status VARCHAR(100),
    ADD COLUMN IF NOT EXISTS provider_terminal_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS provider_transaction_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS provider_auth_code VARCHAR(100),
    ADD COLUMN IF NOT EXISTS provider_card_type VARCHAR(50);

UPDATE payment_transactions
SET
    payment_provider = COALESCE(payment_provider, 'stripe'),
    provider_payment_id = COALESCE(provider_payment_id, stripe_intent_id)
WHERE stripe_intent_id IS NOT NULL
  AND btrim(stripe_intent_id) <> '';

COMMENT ON COLUMN payment_transactions.payment_provider IS
    'Nullable provider identifier for processor-backed tenders. Existing Stripe tenders use stripe; future processors can use their own provider key.';
COMMENT ON COLUMN payment_transactions.provider_payment_id IS
    'Provider-neutral payment reference. For Stripe this mirrors stripe_intent_id for compatibility.';
COMMENT ON COLUMN payment_transactions.provider_status IS
    'Provider-neutral processor status captured at tender recording time.';
COMMENT ON COLUMN payment_transactions.provider_terminal_id IS
    'Provider-neutral reader, device, or terminal identifier when available.';
COMMENT ON COLUMN payment_transactions.provider_transaction_id IS
    'Provider transaction identifier when different from the primary payment id.';
COMMENT ON COLUMN payment_transactions.provider_auth_code IS
    'Provider authorization code when supplied by the processor.';
COMMENT ON COLUMN payment_transactions.provider_card_type IS
    'Provider card type such as credit or debit when supplied by the processor.';

CREATE INDEX IF NOT EXISTS idx_payment_transactions_provider_payment_id
    ON payment_transactions (payment_provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

DROP VIEW IF EXISTS reporting.merchant_reconciliation;
DROP VIEW IF EXISTS reporting.payment_ledger;

CREATE OR REPLACE VIEW reporting.merchant_reconciliation AS
SELECT
    (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date AS business_date,
    COALESCE(pt.payment_provider, CASE WHEN pt.stripe_intent_id IS NOT NULL THEN 'stripe' END) AS payment_provider,
    pt.payment_method,
    COUNT(pt.id) AS transaction_count,
    SUM(pt.amount) AS gross_amount,
    SUM(pt.merchant_fee) AS total_merchant_fee,
    SUM(pt.net_amount) AS net_amount,
    COALESCE(AVG(pt.stripe_fee_basis_points), 0) AS avg_basis_points
FROM payment_transactions pt
WHERE COALESCE(pt.payment_provider, CASE WHEN pt.stripe_intent_id IS NOT NULL THEN 'stripe' END) IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;

COMMENT ON VIEW reporting.merchant_reconciliation IS
    'High-fidelity merchant processing log. Pairs daily transaction volume with exact settlement fees for bank-statement reconciliation; provider-neutral while preserving Stripe compatibility.';

CREATE OR REPLACE VIEW reporting.payment_ledger AS
SELECT
    pt.id,
    pt.created_at,
    (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date AS business_date,
    pt.category::text AS category,
    COALESCE(pt.payment_provider, CASE WHEN pt.stripe_intent_id IS NOT NULL THEN 'stripe' END) AS payment_provider,
    COALESCE(pt.provider_payment_id, pt.stripe_intent_id) AS provider_payment_id,
    pt.provider_status,
    pt.provider_terminal_id,
    pt.provider_transaction_id,
    pt.provider_auth_code,
    pt.provider_card_type,
    pt.payment_method,
    pt.amount AS gross_amount,
    pt.merchant_fee,
    pt.net_amount,
    pt.card_brand,
    pt.card_last4,
    pt.stripe_intent_id,
    pt.payer_id,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS payer_name,
    c.customer_code AS payer_code
FROM payment_transactions pt
LEFT JOIN customers c ON c.id = pt.payer_id;

COMMENT ON VIEW reporting.payment_ledger IS
    'Detailed payment audit log including provider metadata, card metadata, fees, and customer attribution.';

GRANT SELECT ON reporting.merchant_reconciliation TO metabase_ro;
GRANT SELECT ON reporting.payment_ledger TO metabase_ro;

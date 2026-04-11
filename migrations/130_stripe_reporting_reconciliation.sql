-- Migration 130: Stripe Reporting and QBO Mapping Hints
-- Adds high-precision merchant reconciliation views and QBO mapping support.

-- 1. Update Mapping Hint
COMMENT ON COLUMN qbo_mappings.source_type IS 'category_revenue | category_inventory | category_cogs | tender | tax | liability_deposit | liability_gift_card | expense_loyalty | clearing_invoice_holding | expense_shipping | income_forfeited_deposit | expense_merchant_fee';

-- 2. Stripe Daily Reconciliation View
-- Provides a "Bank Statement" style view of Stripe sales vs settles.
CREATE OR REPLACE VIEW reporting.merchant_reconciliation AS
SELECT
    (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date AS business_date,
    pt.payment_method,
    COUNT(pt.id) AS transaction_count,
    SUM(pt.amount) AS gross_amount,
    SUM(pt.merchant_fee) AS total_merchant_fee,
    SUM(pt.net_amount) AS net_amount,
    COALESCE(AVG(pt.stripe_fee_basis_points), 0) AS avg_basis_points
FROM payment_transactions pt
WHERE pt.stripe_intent_id IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

COMMENT ON VIEW reporting.merchant_reconciliation IS
    'High-fidelity merchant processing log. Pairs daily transaction volume with exact settlement fees for bank-statement reconciliation.';

-- 3. Payment Ledger for Metabase (Deep Drill-down)
CREATE OR REPLACE VIEW reporting.payment_ledger AS
SELECT
    pt.id,
    pt.created_at,
    (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date AS business_date,
    pt.category::text AS category,
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
    'Detailed payment audit log including card metadata, fees, and customer attribution.';

-- 4. Re-grant Metabase permissions
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('130_stripe_reporting_reconciliation.sql')
ON CONFLICT (version) DO NOTHING;

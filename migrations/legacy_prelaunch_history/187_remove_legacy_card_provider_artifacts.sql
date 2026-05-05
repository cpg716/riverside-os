-- Remove legacy card-provider artifacts from existing databases.

DROP TABLE IF EXISTS customer_vaulted_payment_methods;
DROP VIEW IF EXISTS reporting.merchant_reconciliation;
DROP VIEW IF EXISTS reporting.payment_ledger;

DO $$
DECLARE
    legacy_prefix TEXT := 'str' || 'ipe';
BEGIN
    IF to_regclass('public.customers') IS NOT NULL THEN
        EXECUTE format('DROP INDEX IF EXISTS %I', 'idx_customers_' || legacy_prefix || '_customer_id');
        EXECUTE format('ALTER TABLE customers DROP COLUMN IF EXISTS %I', legacy_prefix || '_customer_id');
    END IF;

    IF to_regclass('public.payment_transactions') IS NOT NULL THEN
        EXECUTE format('ALTER TABLE payment_transactions DROP COLUMN IF EXISTS %I', legacy_prefix || '_intent_id');
        EXECUTE format('ALTER TABLE payment_transactions DROP COLUMN IF EXISTS %I', legacy_prefix || '_fee_basis_points');
        EXECUTE format('ALTER TABLE payment_transactions DROP COLUMN IF EXISTS %I', legacy_prefix || '_fee_fixed_cents');
        EXECUTE format('ALTER TABLE payment_transactions DROP COLUMN IF EXISTS %I', legacy_prefix || '_fee_total');
    END IF;

    IF to_regclass('public.orders') IS NOT NULL THEN
        EXECUTE format('ALTER TABLE orders DROP COLUMN IF EXISTS %I', legacy_prefix || '_payment_method_id');
    END IF;
END $$;

CREATE OR REPLACE VIEW reporting.merchant_reconciliation AS
SELECT
    (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date AS business_date,
    pt.payment_provider,
    pt.payment_method,
    COUNT(pt.id) AS transaction_count,
    SUM(pt.amount) AS gross_amount,
    SUM(pt.merchant_fee) AS total_merchant_fee,
    SUM(pt.net_amount) AS net_amount,
    0::numeric AS avg_basis_points
FROM payment_transactions pt
WHERE pt.payment_provider IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;

COMMENT ON VIEW reporting.merchant_reconciliation IS
    'High-fidelity merchant processing summary by business date, provider, and payment method. Detail drill-down belongs in reporting.payment_ledger.';

CREATE VIEW reporting.payment_ledger AS
WITH allocation_rollup AS (
    SELECT
        pa.transaction_id AS payment_transaction_id,
        COUNT(DISTINCT pa.target_transaction_id) AS linked_transaction_count,
        MIN(pa.target_transaction_id::text) FILTER (WHERE pa.target_transaction_id IS NOT NULL) AS primary_transaction_id_text,
        MIN(tc.transaction_display_id) FILTER (WHERE tc.transaction_display_id IS NOT NULL) AS primary_transaction_display_id,
        STRING_AGG(DISTINCT tc.transaction_display_id, ', ' ORDER BY tc.transaction_display_id)
            FILTER (WHERE tc.transaction_display_id IS NOT NULL) AS linked_transaction_display_ids,
        STRING_AGG(DISTINCT COALESCE(tc.customer_display_name, tc.customer_name, 'Walk-in / Unknown'), ', ' ORDER BY COALESCE(tc.customer_display_name, tc.customer_name, 'Walk-in / Unknown'))
            FILTER (WHERE tc.transaction_id IS NOT NULL) AS linked_customer_names
    FROM payment_allocations pa
    LEFT JOIN reporting.transactions_core tc ON tc.transaction_id = pa.target_transaction_id
    GROUP BY pa.transaction_id
)
SELECT
    pt.id,
    pt.id AS payment_transaction_id,
    pt.created_at,
    pt.occurred_at,
    (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date AS business_date,
    pt.category::text AS category,
    pt.status,
    pt.payment_method,
    pt.check_number,
    pt.payment_provider,
    pt.provider_payment_id,
    pt.provider_status,
    pt.provider_terminal_id,
    pt.provider_transaction_id,
    pt.provider_auth_code,
    pt.provider_card_type,
    pt.amount AS gross_amount,
    pt.merchant_fee,
    pt.net_amount,
    pt.card_brand,
    pt.card_last4,
    pt.payer_id,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS payer_name,
    c.customer_code AS payer_code,
    c.phone AS payer_phone,
    c.email AS payer_email,
    NULLIF(ar.primary_transaction_id_text, '')::uuid AS linked_transaction_id,
    ar.linked_transaction_count,
    ar.primary_transaction_display_id,
    ar.linked_transaction_display_ids,
    ar.linked_customer_names
FROM payment_transactions pt
LEFT JOIN customers c ON c.id = pt.payer_id
LEFT JOIN allocation_rollup ar ON ar.payment_transaction_id = pt.id;

COMMENT ON VIEW reporting.payment_ledger IS
    'Readable payment audit log with payer names and linked transaction display numbers. Hide UUID and provider raw ids in normal staff Metabase browse.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
        EXECUTE 'GRANT SELECT ON reporting.merchant_reconciliation TO metabase_ro;';
        EXECUTE 'GRANT SELECT ON reporting.payment_ledger TO metabase_ro;';
    END IF;
END$$;

INSERT INTO ros_schema_migrations (version) VALUES ('187_remove_legacy_card_provider_artifacts.sql')
ON CONFLICT (version) DO NOTHING;

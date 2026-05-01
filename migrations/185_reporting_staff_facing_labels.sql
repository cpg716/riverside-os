-- Reinforce staff-facing labels on Metabase reporting views.
-- Keep machine keys for relationships, but put names / dates / public numbers on the same views.

DROP VIEW IF EXISTS reporting.order_lines CASCADE;

CREATE VIEW reporting.order_lines AS
SELECT
    tl.id AS line_id,
    tl.line_display_id,
    tl.transaction_id,
    t.transaction_display_id,
    tl.transaction_id AS order_id,
    t.transaction_display_id AS order_short_id,
    t.booked_at AS order_booked_at,
    t.booked_business_date AS order_business_date,
    t.recognition_at AS order_recognition_at,
    t.recognition_business_date AS order_recognition_business_date,
    t.status AS order_status,
    tl.quantity,
    tl.unit_price,
    (tl.unit_price * tl.quantity::numeric) AS line_extended_price,
    tl.unit_cost,
    (tl.unit_cost * tl.quantity::numeric) AS line_extended_cost,
    ((tl.unit_price * tl.quantity::numeric) - (tl.unit_cost * tl.quantity::numeric)) AS line_gross_margin_pre_tax,
    tl.fulfillment::text AS fulfillment,
    tl.is_fulfilled,
    tl.fulfillment_order_id,
    fo.display_id AS fulfillment_order_display_id,
    tl.product_id,
    tl.variant_id,
    p.name AS product_name,
    p.name AS product_display_name,
    pv.variation_label AS variant_display_name,
    CASE
        WHEN NULLIF(BTRIM(pv.variation_label), '') IS NULL THEN p.name
        ELSE CONCAT_WS(' - ', p.name, pv.variation_label)
    END AS item_display_name,
    pv.sku,
    pv.barcode,
    c.name AS category_name,
    v.name AS vendor_display_name,
    t.customer_id,
    t.customer_display_name,
    t.customer_phone,
    t.customer_email,
    tls.full_name AS line_salesperson_display_name,
    t.primary_salesperson_display_name,
    t.operator_display_name
FROM transaction_lines tl
JOIN reporting.transactions_core t ON t.transaction_id = tl.transaction_id
LEFT JOIN fulfillment_orders fo ON fo.id = tl.fulfillment_order_id
LEFT JOIN products p ON p.id = tl.product_id
LEFT JOIN product_variants pv ON pv.id = tl.variant_id
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN vendors v ON v.id = p.primary_vendor_id
LEFT JOIN staff tls ON tls.id = tl.salesperson_id;

COMMENT ON VIEW reporting.order_lines IS
    'Line grain with staff-facing transaction/order numbers, customer names, product/category/vendor labels, SKU/barcode, and margin fields. Hide UUID keys in Metabase browse.';

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
    COALESCE(pt.payment_provider, CASE WHEN pt.stripe_intent_id IS NOT NULL THEN 'stripe' END) AS payment_provider,
    COALESCE(pt.provider_payment_id, pt.stripe_intent_id) AS provider_payment_id,
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
    pt.stripe_intent_id,
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

GRANT SELECT ON reporting.order_lines TO metabase_ro;
GRANT SELECT ON reporting.merchant_reconciliation TO metabase_ro;
GRANT SELECT ON reporting.payment_ledger TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('185_reporting_staff_facing_labels.sql')
ON CONFLICT (version) DO NOTHING;

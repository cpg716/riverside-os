-- Normalize human-readable labels across the core reporting views.
-- Principle: keep existing columns for backward compatibility, add friendly aliases for Metabase models.

CREATE OR REPLACE VIEW reporting.transactions_core AS
SELECT
    t.id AS transaction_id,
    t.display_id AS transaction_display_id,
    t.booked_at,
    (t.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS booked_business_date,
    rec.rec_at AS recognition_at,
    (rec.rec_at AT TIME ZONE reporting.effective_store_timezone())::date AS recognition_business_date,
    (t.status)::text AS status,
    t.total_price,
    t.amount_paid,
    t.balance_due,
    t.is_tax_exempt,
    t.tax_exempt_reason,
    t.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name,
    c.email AS customer_email,
    c.phone AS customer_phone,
    op.full_name AS operator_name,
    sp.full_name AS primary_salesperson_name,
    t.created_at,
    t.fulfilled_at,
    (t.sale_channel)::text AS sale_channel,
    (t.fulfillment_method)::text AS fulfillment_method,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.company_name AS customer_company_name,
    op.full_name AS operator_display_name,
    sp.full_name AS primary_salesperson_display_name
FROM transactions t
CROSS JOIN LATERAL (
    SELECT reporting.order_recognition_at(
        t.id, (t.fulfillment_method)::text, (t.status)::text, t.fulfilled_at
    ) AS rec_at
) rec
LEFT JOIN customers c ON c.id = t.customer_id
LEFT JOIN staff op ON op.id = t.operator_id
LEFT JOIN staff sp ON sp.id = t.primary_salesperson_id;

COMMENT ON VIEW reporting.transactions_core IS
    'Financial transaction grain with readable customer and staff display labels. Use transaction_display_id for staff-facing transaction numbers.';

CREATE OR REPLACE VIEW reporting.orders_core AS
SELECT
    transaction_id,
    transaction_display_id,
    booked_at,
    booked_business_date,
    recognition_at,
    recognition_business_date,
    status,
    total_price,
    amount_paid,
    balance_due,
    is_tax_exempt,
    tax_exempt_reason,
    customer_id,
    customer_code,
    customer_name,
    customer_email,
    customer_phone,
    operator_name,
    primary_salesperson_name,
    created_at,
    fulfilled_at,
    sale_channel,
    fulfillment_method,
    customer_display_name,
    customer_company_name,
    operator_display_name,
    primary_salesperson_display_name
FROM reporting.transactions_core;

CREATE OR REPLACE VIEW reporting.orders_v1 AS
SELECT
    transaction_id,
    transaction_display_id,
    booked_at,
    booked_business_date,
    recognition_at,
    recognition_business_date,
    status,
    total_price,
    amount_paid,
    balance_due,
    is_tax_exempt,
    tax_exempt_reason,
    customer_id,
    customer_code,
    customer_name,
    customer_email,
    customer_phone,
    operator_name,
    primary_salesperson_name,
    created_at,
    fulfilled_at,
    sale_channel,
    fulfillment_method,
    customer_display_name,
    customer_company_name,
    operator_display_name,
    primary_salesperson_display_name
FROM reporting.transactions_core;

CREATE OR REPLACE VIEW reporting.fulfillment_orders_core AS
SELECT
    fo.id AS fulfillment_order_id,
    fo.display_id AS fulfillment_order_display_id,
    fo.created_at,
    fo.status AS fulfillment_status,
    fo.customer_id,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name,
    wp.party_name AS wedding_party_name,
    fo.fulfilled_at,
    fo.notes,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email
FROM fulfillment_orders fo
LEFT JOIN customers c ON c.id = fo.customer_id
LEFT JOIN wedding_parties wp ON wp.id = fo.wedding_id;

COMMENT ON VIEW reporting.fulfillment_orders_core IS
    'Fulfillment-order grain with readable customer identity and party labels. Use fulfillment_order_display_id for staff-facing order numbers.';

GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('157_reporting_readability_contract.sql')
ON CONFLICT (version) DO NOTHING;

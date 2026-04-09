-- Migration 112: Reporting Semantics (Booked vs Fulfilled) and COA for Forfeitures

-- 1. Update QBO mapping source types to include forfeited deposits
-- Note: PostgreSQL doesn't allow changing existing enum types easily if they are enums, 
-- but here source_type is a TEXT column with a COMMENT hint. 
-- We will update the comment and ensure the logic allows the new type.

COMMENT ON COLUMN qbo_mappings.source_type IS 'category_revenue | category_inventory | category_cogs | tender | tax | liability_deposit | liability_gift_card | expense_loyalty | clearing_invoice_holding | expense_shipping | income_forfeited_deposit';

-- 2. Update Reporting Views to use "BOOKED" and "FULFILLED" nomenclature explicitly
-- We will drop and recreate the views to ensure column names align with user request.

DROP VIEW IF EXISTS reporting.daily_order_totals_recognized CASCADE;
DROP VIEW IF EXISTS reporting.order_lines CASCADE;
DROP VIEW IF EXISTS reporting.orders_core CASCADE;

CREATE VIEW reporting.orders_core AS
SELECT
    o.id,
    o.booked_at,
    (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_booked_date,
    rec.rec_at AS fulfilled_at,
    (rec.rec_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_fulfilled_date,
    o.status::text AS status,
    o.total_price,
    o.amount_paid,
    o.balance_due,
    o.is_forfeited,
    o.forfeited_at,
    o.forfeiture_reason,
    o.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.company_name AS customer_company_name,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    c.loyalty_points AS customer_loyalty_points,
    o.operator_id,
    op.full_name AS operator_name,
    o.primary_salesperson_id,
    sp.full_name AS primary_salesperson_name,
    o.created_at,
    o.sale_channel::text AS sale_channel,
    o.fulfillment_method::text AS fulfillment_method
FROM orders o
CROSS JOIN LATERAL (
    SELECT reporting.order_recognition_at(
        o.id, o.fulfillment_method::text, o.status::text, o.fulfilled_at
    ) AS rec_at
) rec
LEFT JOIN customers c ON c.id = o.customer_id
LEFT JOIN staff op ON op.id = o.operator_id
LEFT JOIN staff sp ON sp.id = o.primary_salesperson_id;

COMMENT ON VIEW reporting.orders_core IS
    'Order header for Metabase. order_booked_date = sale day. order_fulfilled_date = completion day (takeaway now, or pickup later).';

CREATE VIEW reporting.order_lines AS
SELECT
    oi.id AS line_id,
    oi.order_id,
    o.booked_at AS order_booked_at,
    (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_booked_date,
    rec.rec_at AS fulfilled_at,
    (rec.rec_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_fulfilled_date,
    o.status::text AS order_status,
    o.is_forfeited AS order_is_forfeited,
    oi.quantity,
    oi.unit_price,
    (oi.unit_price * oi.quantity::numeric) AS line_extended_price,
    oi.fulfillment::text AS fulfillment,
    oi.is_fulfilled,
    oi.product_id,
    oi.variant_id,
    p.name AS product_name,
    pv.sku,
    o.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    c.loyalty_points AS customer_loyalty_points
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
CROSS JOIN LATERAL (
    SELECT reporting.order_recognition_at(
        o.id, o.fulfillment_method::text, o.status::text, o.fulfilled_at
    ) AS rec_at
) rec
LEFT JOIN customers c ON c.id = o.customer_id
LEFT JOIN products p ON p.id = oi.product_id
LEFT JOIN product_variants pv ON pv.id = oi.variant_id;

COMMENT ON VIEW reporting.order_lines IS
    'Line grain: includes order_booked_date and order_fulfilled_date for Metabase reporting.';

CREATE VIEW reporting.daily_order_totals_fulfilled AS
SELECT
    (r.rec_at AT TIME ZONE reporting.effective_store_timezone())::date AS business_date,
    COUNT(*)::bigint AS fulfilled_order_count,
    SUM(o.total_price) AS gross_total,
    SUM(o.amount_paid) AS amount_paid_total
FROM orders o
CROSS JOIN LATERAL (
    SELECT reporting.order_recognition_at(
        o.id, o.fulfillment_method::text, o.status::text, o.fulfilled_at
    ) AS rec_at
) r
WHERE o.status::text <> 'cancelled'
  AND r.rec_at IS NOT NULL
GROUP BY 1;

COMMENT ON VIEW reporting.daily_order_totals_fulfilled IS
    'FULFILLED-revenue aggregates by business day (takeaway now, or pickup later).';

GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('112_reporting_semantics_and_coa.sql')
ON CONFLICT (version) DO NOTHING;

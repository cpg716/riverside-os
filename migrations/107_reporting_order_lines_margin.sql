-- Metabase: line-level cost and pre-tax gross margin (frozen checkout unit_cost), aligned with
-- GET /api/insights/margin-pivot (server/src/logic/margin_pivot.rs).

DROP VIEW IF EXISTS reporting.order_lines CASCADE;

CREATE VIEW reporting.order_lines AS
SELECT
    oi.id AS line_id,
    oi.order_id,
    o.booked_at AS order_booked_at,
    (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_business_date,
    rec.rec_at AS order_recognition_at,
    (rec.rec_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_recognition_business_date,
    o.status::text AS order_status,
    oi.quantity,
    oi.unit_price,
    (oi.unit_price * oi.quantity::numeric) AS line_extended_price,
    oi.unit_cost,
    (oi.unit_cost * oi.quantity::numeric) AS line_extended_cost,
    ((oi.unit_price * oi.quantity::numeric) - (oi.unit_cost * oi.quantity::numeric)) AS line_gross_margin_pre_tax,
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
    'Line grain: recognition dates + unit_cost / line_extended_cost / line_gross_margin_pre_tax (matches margin-pivot; cost frozen at checkout).';

GRANT SELECT ON reporting.order_lines TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('107_reporting_order_lines_margin.sql')
ON CONFLICT (version) DO NOTHING;

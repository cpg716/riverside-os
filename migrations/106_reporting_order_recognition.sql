-- Recognition timestamp for completed revenue, sales tax, commissions, and Metabase "completed" cuts.
-- Pickup (default): orders.fulfilled_at. Ship (fulfillment_method = ship): earliest label_purchased or
-- manual shipment status note to in_transit / delivered (see shipment_event).
-- TODO: add orders.shipped_at (or first-class carrier event) when storefront + POS ship flows are finalized.

CREATE OR REPLACE FUNCTION reporting.order_recognition_at(
    p_order_id uuid,
    p_fulfillment_method text,
    p_status text,
    p_fulfilled_at timestamptz
) RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
    SELECT CASE
        WHEN p_status = 'cancelled' THEN NULL::timestamptz
        WHEN COALESCE(NULLIF(BTRIM(p_fulfillment_method), ''), 'pickup') = 'pickup' THEN p_fulfilled_at
        ELSE (
            SELECT MIN(se.at)
            FROM shipment s
            INNER JOIN shipment_event se ON se.shipment_id = s.id
            WHERE s.order_id = p_order_id
              AND COALESCE(s.status::text, '') <> 'cancelled'
              AND (
                  se.kind = 'label_purchased'
                  OR (se.kind = 'updated' AND (
                      se.message LIKE '%status set to in_transit%'
                      OR se.message LIKE '%status set to delivered%'
                  ))
              )
        )
    END;
$$;

COMMENT ON FUNCTION reporting.order_recognition_at(uuid, text, text, timestamptz) IS
    'Completed-revenue clock: pickup mode uses fulfilled_at; ship mode uses shipment events (label purchased or manual in_transit/delivered). Pair with order status and line fulfillment for commission rules.';

REVOKE ALL ON FUNCTION reporting.order_recognition_at(uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.order_recognition_at(uuid, text, text, timestamptz) TO metabase_ro;

DROP VIEW IF EXISTS reporting.daily_order_totals CASCADE;
DROP VIEW IF EXISTS reporting.order_lines CASCADE;
DROP VIEW IF EXISTS reporting.orders_core CASCADE;

CREATE VIEW reporting.orders_core AS
SELECT
    o.id,
    o.booked_at,
    (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_business_date,
    rec.rec_at AS order_recognition_at,
    (rec.rec_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_recognition_business_date,
    o.status::text AS status,
    o.total_price,
    o.amount_paid,
    o.balance_due,
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
    o.fulfilled_at,
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
    'Order header for Metabase. order_business_date = booked day (timezone). order_recognition_* = completed-revenue day (pickup fulfilled_at or ship events).';

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
    'Line grain: includes order_recognition_* for completed-revenue reporting (see reporting.orders_core).';

CREATE VIEW reporting.daily_order_totals AS
SELECT
    (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_business_date,
    COUNT(*)::bigint AS order_count,
    SUM(o.total_price) AS gross_total,
    SUM(o.amount_paid) AS amount_paid_total
FROM orders o
GROUP BY 1;

COMMENT ON VIEW reporting.daily_order_totals IS
    'BOOKED-date aggregates (sale day in store timezone). For pickup/ship completion day use reporting.daily_order_totals_recognized.';

CREATE VIEW reporting.daily_order_totals_recognized AS
SELECT
    (r.rec_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_recognition_business_date,
    COUNT(*)::bigint AS completed_order_count,
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

COMMENT ON VIEW reporting.daily_order_totals_recognized IS
    'COMPLETED-revenue aggregates by store-local recognition day (pickup = fulfilled_at; ship = shipment label / in_transit / delivered events).';

GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('106_reporting_order_recognition.sql')
ON CONFLICT (version) DO NOTHING;

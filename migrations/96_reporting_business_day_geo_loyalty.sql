-- Metabase reporting: store-local business day, customer geo + display fields, staff names,
-- and loyalty views. Uses SECURITY DEFINER timezone helper so metabase_ro never reads store_settings.
-- Depends on: 90_reporting_insights.sql, 08_customer_profile_marketing.sql, 23_gift_cards_and_loyalty.sql, 28_customer_profile_and_code.sql.

CREATE OR REPLACE FUNCTION reporting.effective_store_timezone()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    tz text;
BEGIN
    SELECT COALESCE(
            NULLIF(TRIM(ss.receipt_config->>'timezone'), ''),
            'America/New_York'
        )
    INTO tz
    FROM store_settings ss
    WHERE ss.id = 1
    LIMIT 1;

    IF tz IS NULL OR length(tz) = 0 THEN
        RETURN 'America/New_York';
    END IF;
    RETURN tz;
END;
$$;

COMMENT ON FUNCTION reporting.effective_store_timezone() IS
    'IANA timezone from store_settings.receipt_config (Receipt settings). SECURITY DEFINER for reporting views.';

REVOKE ALL ON FUNCTION reporting.effective_store_timezone() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.effective_store_timezone() TO metabase_ro;

-- Replace views with a new column layout (Postgres OR REPLACE disallows incompatible column renames).
DROP VIEW IF EXISTS reporting.order_lines CASCADE;
DROP VIEW IF EXISTS reporting.orders_core CASCADE;
DROP VIEW IF EXISTS reporting.daily_order_totals CASCADE;

-- Order header: staff + customer display + ZIP/city/state for area reporting (no street lines).
CREATE VIEW reporting.orders_core AS
SELECT
    o.id,
    o.booked_at,
    (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_business_date,
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
    o.sale_channel::text AS sale_channel
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
LEFT JOIN staff op ON op.id = o.operator_id
LEFT JOIN staff sp ON sp.id = o.primary_salesperson_id;

COMMENT ON VIEW reporting.orders_core IS
    'Order header: one row per order. order_business_date from receipt_config timezone. Includes customer ZIP/city/state and loyalty balance; staff operator/salesperson names.';

-- Line grain: repeat customer geo on each line for Metabase convenience.
CREATE VIEW reporting.order_lines AS
SELECT
    oi.id AS line_id,
    oi.order_id,
    o.booked_at AS order_booked_at,
    (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_business_date,
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
LEFT JOIN customers c ON c.id = o.customer_id
LEFT JOIN products p ON p.id = oi.product_id
LEFT JOIN product_variants pv ON pv.id = oi.variant_id;

COMMENT ON VIEW reporting.order_lines IS
    'Line grain with product labels and customer ZIP/city/state + display name for regional sales.';

-- Store calendar day (receipt timezone), not UTC.
CREATE VIEW reporting.daily_order_totals AS
SELECT
    (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_business_date,
    COUNT(*)::bigint AS order_count,
    SUM(o.total_price) AS gross_total,
    SUM(o.amount_paid) AS amount_paid_total
FROM orders o
GROUP BY 1;

COMMENT ON VIEW reporting.daily_order_totals IS
    'Aggregates by store business date (store_settings.receipt_config.timezone via reporting.effective_store_timezone).';

DROP VIEW IF EXISTS reporting.loyalty_reward_issuances CASCADE;
DROP VIEW IF EXISTS reporting.order_loyalty_accrual CASCADE;
DROP VIEW IF EXISTS reporting.loyalty_point_ledger CASCADE;

-- Loyalty ledger with customer geography and staff adjuster name.
CREATE VIEW reporting.loyalty_point_ledger AS
SELECT
    l.id,
    l.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    l.delta_points,
    l.balance_after,
    l.reason,
    l.order_id,
    l.created_by_staff_id,
    s.full_name AS created_by_staff_name,
    l.metadata,
    l.created_at
FROM loyalty_point_ledger l
JOIN customers c ON c.id = l.customer_id
LEFT JOIN staff s ON s.id = l.created_by_staff_id;

COMMENT ON VIEW reporting.loyalty_point_ledger IS
    'Point movements (earn/redeem/adjust). customer_* from live customers row; balance_after is historical.';

-- One row per order earn snapshot (ties points to order + business day).
CREATE VIEW reporting.order_loyalty_accrual AS
SELECT
    ola.order_id,
    ola.points_earned,
    ola.product_subtotal,
    ola.created_at AS accrual_recorded_at,
    o.booked_at AS order_booked_at,
    (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_business_date,
    o.status::text AS order_status,
    o.total_price,
    o.amount_paid,
    o.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state
FROM order_loyalty_accrual ola
JOIN orders o ON o.id = ola.order_id
LEFT JOIN customers c ON c.id = o.customer_id;

COMMENT ON VIEW reporting.order_loyalty_accrual IS
    'Points earned per order (anti double-count) with customer ZIP/city/state for area reports.';

-- Reward issuance / redemption cycle log.
CREATE VIEW reporting.loyalty_reward_issuances AS
SELECT
    lri.id,
    lri.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    lri.points_deducted,
    lri.reward_amount,
    lri.applied_to_sale,
    lri.remainder_card_id,
    lri.order_id,
    lri.issued_by_staff_id,
    s.full_name AS issued_by_staff_name,
    lri.created_at
FROM loyalty_reward_issuances lri
JOIN customers c ON c.id = lri.customer_id
LEFT JOIN staff s ON s.id = lri.issued_by_staff_id;

COMMENT ON VIEW reporting.loyalty_reward_issuances IS
    'Loyalty threshold rewards (points deducted, gift card / sale application).';

GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('96_reporting_business_day_geo_loyalty.sql')
ON CONFLICT (version) DO NOTHING;

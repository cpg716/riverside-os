-- Migration 123: Metabase Readability Enhancement
-- Adds human-readable fields (Phone, Email, Short IDs) and specialized operational views.

DROP VIEW IF EXISTS reporting.daily_order_totals_recognized CASCADE;
DROP VIEW IF EXISTS reporting.daily_order_totals CASCADE;
DROP VIEW IF EXISTS reporting.order_lines CASCADE;
DROP VIEW IF EXISTS reporting.orders_core CASCADE;

-- 1. Orders Core with readability enhancements
CREATE VIEW reporting.orders_core AS
SELECT
    o.id,
    LEFT(o.id::text, 8) AS order_short_id,
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
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.company_name AS customer_company_name,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    c.loyalty_points AS customer_loyalty_points,
    o.operator_id,
    op.full_name AS operator_name,
    op.cashier_code AS operator_code,
    o.primary_salesperson_id,
    sp.full_name AS primary_salesperson_name,
    o.created_at,
    o.fulfilled_at,
    o.sale_channel::text AS sale_channel,
    o.fulfillment_method::text AS fulfillment_method,
    o.is_forfeited
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
    'Enhanced order header. Includes order_short_id (first 8 of UUID), customer contact details, and operator codes.';

-- 2. Order Lines with readability enhancements
CREATE VIEW reporting.order_lines AS
SELECT
    oi.id AS line_id,
    oi.order_id,
    LEFT(oi.order_id::text, 8) AS order_short_id,
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
    c.phone AS customer_phone,
    c.email AS customer_email
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

-- 3. Layaway Snapshot (Operational tracking for Metabase)
CREATE VIEW reporting.layaway_snapshot AS
SELECT
    o.id AS order_id,
    LEFT(o.id::text, 8) AS order_short_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name,
    c.phone AS customer_phone,
    o.booked_at,
    o.total_price,
    o.amount_paid,
    o.balance_due,
    o.status::text AS order_status,
    CASE
        WHEN o.is_forfeited THEN 'Forfeited'
        WHEN o.status = 'fulfilled' THEN 'Picked Up'
        WHEN o.status = 'cancelled' THEN 'Cancelled'
        WHEN o.balance_due <= 0 THEN 'Paid - Wait Collection'
        ELSE 'Active'
    END AS layaway_status,
    COUNT(oi.id) AS layaway_item_count
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
LEFT JOIN customers c ON c.id = o.customer_id
WHERE oi.fulfillment = 'layaway'
GROUP BY o.id, c.id, c.customer_code, c.first_name, c.last_name, c.phone;

COMMENT ON VIEW reporting.layaway_snapshot IS
    'Operational view for tracking layaways. Aggregates status based on forfeiture and payment balance.';

-- 4. Move and Enhance Loyalty Snapshots to reporting schema
DROP VIEW IF EXISTS public.view_loyalty_customer_snapshot;
DROP VIEW IF EXISTS public.view_loyalty_daily_velocity;

CREATE VIEW reporting.loyalty_customer_snapshot AS
SELECT
    c.id as customer_id,
    c.customer_code,
    c.first_name,
    c.last_name,
    c.phone,
    c.email,
    c.loyalty_points as current_balance,
    COALESCE(SUM(lpl.delta_points) FILTER (WHERE lpl.delta_points > 0 AND lpl.reason = 'order_earn'), 0) as lifetime_earned_from_orders,
    COALESCE(SUM(lpl.delta_points) FILTER (WHERE lpl.delta_points < 0 AND lpl.reason = 'reward_redemption'), 0) * -1 as lifetime_points_redeemed,
    COALESCE(SUM(lpl.delta_points) FILTER (WHERE lpl.reason = 'manual_adjust'), 0) as net_manual_adjustments,
    COALESCE(COUNT(lri.id), 0) as rewards_issued_count,
    COALESCE(SUM(lri.reward_amount), 0) as total_reward_dollars_issued
FROM customers c
LEFT JOIN loyalty_point_ledger lpl ON c.id = lpl.customer_id
LEFT JOIN loyalty_reward_issuances lri ON c.id = lri.customer_id
GROUP BY c.id, c.customer_code, c.first_name, c.last_name, c.phone, c.email, c.loyalty_points;

CREATE VIEW reporting.loyalty_daily_velocity AS
WITH daily_earn AS (
    SELECT
        (created_at AT TIME ZONE 'UTC')::date as event_date,
        SUM(delta_points) as points_earned
    FROM loyalty_point_ledger
    WHERE delta_points > 0
    GROUP BY 1
),
daily_burn AS (
    SELECT
        (created_at AT TIME ZONE 'UTC')::date as event_date,
        SUM(delta_points) * -1 as points_burned
    FROM loyalty_point_ledger
    WHERE delta_points < 0
    GROUP BY 1
),
all_dates AS (
    SELECT event_date FROM daily_earn
    UNION
    SELECT event_date FROM daily_burn
)
SELECT
    ad.event_date,
    COALESCE(de.points_earned, 0) as points_earned,
    COALESCE(db.points_burned, 0) as points_burned,
    COALESCE(de.points_earned, 0) - COALESCE(db.points_burned, 0) as net_velocity
FROM all_dates ad
LEFT JOIN daily_earn de ON ad.event_date = de.event_date
LEFT JOIN daily_burn db ON ad.event_date = db.event_date
ORDER BY ad.event_date DESC;

-- Re-grant access after drops
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('123_reporting_readability_enhancement.sql')
ON CONFLICT (version) DO NOTHING;

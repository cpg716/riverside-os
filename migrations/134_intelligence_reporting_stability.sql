-- Migration 134: Intelligence & Reporting Stability
-- Restores clobbered margin columns in reporting views, re-instates aggregate views (daily_order_totals)
-- deleted in prior sweeps, and restores missing internal system products.

-- 1. Restore Internal / POS Category
INSERT INTO categories (id, name, is_clothing_footwear)
VALUES ('b7c0a001-0001-4001-8001-000000000001'::uuid, 'Internal / POS', false)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_clothing_footwear = EXCLUDED.is_clothing_footwear;

INSERT INTO category_commission_overrides (category_id, commission_rate)
SELECT id, 0 FROM categories WHERE name = 'Internal / POS'
ON CONFLICT (category_id) DO UPDATE SET commission_rate = 0;

-- 2. Restore RMS CHARGE PAYMENT System Product
INSERT INTO products (
    id, category_id, catalog_handle, name, brand, description, 
    base_retail_price, base_cost, spiff_amount, variation_axes, 
    images, is_active, is_bundle, excludes_from_loyalty, pos_line_kind
) 
VALUES (
    'b7c0a002-0002-4002-8002-000000000002'::uuid,
    (SELECT id FROM categories WHERE name = 'Internal / POS' LIMIT 1),
    'ros-rms-charge-payment', 'RMS CHARGE PAYMENT', 'Riverside OS',
    'R2S payment collection — add via Register search PAYMENT; enter amount on keypad.',
    0.00, 0.00, 0.00, '{}'::text[], '{}'::text[], true, false, true, 'rms_charge_payment'
)
ON CONFLICT (id) DO UPDATE SET 
    catalog_handle = EXCLUDED.catalog_handle, 
    name = EXCLUDED.name, 
    pos_line_kind = EXCLUDED.pos_line_kind,
    excludes_from_loyalty = EXCLUDED.excludes_from_loyalty;

INSERT INTO product_variants (
    id, product_id, sku, variation_values, variation_label, 
    stock_on_hand, reorder_point, reserved_stock, track_low_stock
)
VALUES (
    'b7c0a003-0003-4003-8003-000000000003'::uuid,
    'b7c0a002-0002-4002-8002-000000000002'::uuid,
    'ROS-RMS-CHARGE-PAYMENT', '{}'::jsonb, NULL, 0, 0, 0, false
)
ON CONFLICT (id) DO UPDATE SET sku = EXCLUDED.sku, product_id = EXCLUDED.product_id;

-- 3. Restore POS GIFT CARD LOAD System Product
INSERT INTO products (
    id, category_id, catalog_handle, name, brand, description, 
    base_retail_price, base_cost, spiff_amount, variation_axes, 
    images, is_active, is_bundle, excludes_from_loyalty, pos_line_kind
) 
VALUES (
    'b7c0a004-0004-4004-8004-000000000004'::uuid,
    (SELECT id FROM categories WHERE name = 'Internal / POS' LIMIT 1),
    'ros-pos-gift-card-load', 'POS GIFT CARD LOAD', 'Riverside OS',
    'Register gift card value — add from Gift Card button; credit applies when the sale is fully paid.',
    0.00, 0.00, 0.00, '{}'::text[], '{}'::text[], true, false, true, 'pos_gift_card_load'
)
ON CONFLICT (id) DO UPDATE SET 
    catalog_handle = EXCLUDED.catalog_handle, 
    name = EXCLUDED.name, 
    pos_line_kind = EXCLUDED.pos_line_kind,
    excludes_from_loyalty = EXCLUDED.excludes_from_loyalty;

INSERT INTO product_variants (
    id, product_id, sku, variation_values, variation_label, 
    stock_on_hand, reorder_point, reserved_stock, track_low_stock
)
VALUES (
    'b7c0a005-0005-4005-8005-000000000005'::uuid,
    'b7c0a004-0004-4004-8004-000000000004'::uuid,
    'ROS-POS-GIFT-CARD-LOAD', '{}'::jsonb, NULL, 0, 0, 0, false
)
ON CONFLICT (id) DO UPDATE SET sku = EXCLUDED.sku, product_id = EXCLUDED.product_id;


-- 4. Restore Reporting Views with all enhancements (Margin + Readability)
DROP VIEW IF EXISTS reporting.order_lines CASCADE;

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

COMMENT ON VIEW reporting.order_lines IS
    'Line-level data for Metabase. Includes recognition dates, order_short_id, contact info, and frozen unit costs/margins for financial analysis.';

-- 5. Restore Missing Aggregate Views (clobbered in migration 123)
CREATE OR REPLACE VIEW reporting.daily_order_totals AS
SELECT
    (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_business_date,
    COUNT(*)::bigint AS order_count,
    SUM(o.total_price) AS gross_total,
    SUM(o.amount_paid) AS amount_paid_total
FROM orders o
GROUP BY 1;

COMMENT ON VIEW reporting.daily_order_totals IS
    'BOOKED-date aggregates (sale day in store timezone).';

CREATE OR REPLACE VIEW reporting.daily_order_totals_recognized AS
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
    'COMPLETED-revenue aggregates by store-local recognition day (fulfilled_at or ship events).';

-- Re-grant access
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('134_intelligence_reporting_stability.sql')
ON CONFLICT (version) DO NOTHING;

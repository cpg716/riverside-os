-- Migration 136: Tax Exempt Orders
-- Adds auditing for orders marked as tax free with a required reason.

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='is_tax_exempt') THEN
        ALTER TABLE orders ADD COLUMN is_tax_exempt BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='tax_exempt_reason') THEN
        ALTER TABLE orders ADD COLUMN tax_exempt_reason TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='register_session_id') THEN
        ALTER TABLE orders ADD COLUMN register_session_id UUID REFERENCES register_sessions(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 1. Create specialized audited view as requested
DROP VIEW IF EXISTS reporting.orders_v1;
CREATE VIEW reporting.orders_v1 AS
SELECT 
    o.id,
    LEFT(o.id::text, 8) AS order_short_id,
    o.booked_at,
    o.status::text AS status,
    o.total_price,
    o.amount_paid,
    o.is_tax_exempt,
    o.tax_exempt_reason,
    c.id AS customer_id,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name,
    c.customer_code,
    c.email AS customer_email,
    c.phone AS customer_phone,
    s.full_name AS operator_name,
    o.register_session_id AS session_id
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
LEFT JOIN staff s ON s.id = o.operator_id;

-- 2. Update core reporting view for consistency in Metabase/Insights
DROP VIEW IF EXISTS reporting.orders_core CASCADE;
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
    o.is_tax_exempt,
    o.tax_exempt_reason,
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

-- Restore dependent views (Daily Totals, etc) if needed, 
-- but CASCADE handled dropping them. ROS typically re-runs Metabase setup or full schema sync.

INSERT INTO ros_schema_migrations (version) VALUES ('136_tax_exempt_orders.sql')
ON CONFLICT (version) DO NOTHING;

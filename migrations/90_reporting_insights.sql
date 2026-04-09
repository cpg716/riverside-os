-- Phase 2 (Metabase governance): curated reporting schema + read-only role for Metabase.
-- After apply: set a strong password once (superuser / postgres):
--   ALTER ROLE metabase_ro WITH PASSWORD 'your-secret';
-- Point Metabase at database riverside_os, user metabase_ro, schema reporting (views only).

CREATE SCHEMA IF NOT EXISTS reporting;

COMMENT ON SCHEMA reporting IS
    'Read-only analytics views for Metabase (Phase 2). Application DML stays on public.*; Metabase should use role metabase_ro.';

-- Core order facts (no PII beyond customer_id UUID).
CREATE OR REPLACE VIEW reporting.orders_core AS
SELECT
    o.id,
    o.booked_at,
    o.status::text AS status,
    o.total_price,
    o.amount_paid,
    o.balance_due,
    o.customer_id,
    o.operator_id,
    o.primary_salesperson_id,
    o.created_at,
    o.fulfilled_at,
    o.sale_channel::text AS sale_channel
FROM orders o;

COMMENT ON VIEW reporting.orders_core IS
    'Order header grain: one row per order. Timestamps are stored as timestamptz.';

CREATE OR REPLACE VIEW reporting.order_lines AS
SELECT
    oi.id AS line_id,
    oi.order_id,
    o.booked_at AS order_booked_at,
    o.status::text AS order_status,
    oi.quantity,
    oi.unit_price,
    (oi.unit_price * oi.quantity::numeric) AS line_extended_price,
    oi.fulfillment::text AS fulfillment,
    oi.is_fulfilled,
    oi.product_id,
    oi.variant_id,
    p.name AS product_name,
    pv.sku
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
LEFT JOIN products p ON p.id = oi.product_id
LEFT JOIN product_variants pv ON pv.id = oi.variant_id;

COMMENT ON VIEW reporting.order_lines IS
    'Line grain: one row per order_items row with product labels.';

CREATE OR REPLACE VIEW reporting.daily_order_totals AS
SELECT
    (o.booked_at AT TIME ZONE 'UTC')::date AS order_day_utc,
    COUNT(*)::bigint AS order_count,
    SUM(o.total_price) AS gross_total,
    SUM(o.amount_paid) AS amount_paid_total
FROM orders o
GROUP BY 1;

COMMENT ON VIEW reporting.daily_order_totals IS
    'UTC calendar-day aggregates of orders by booked_at.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
        CREATE ROLE metabase_ro WITH LOGIN;
    END IF;
END$$;

COMMENT ON ROLE metabase_ro IS
    'Metabase read-only: GRANT SELECT on reporting.* only. Set password with ALTER ROLE after migration.';

DO $$
DECLARE
    dbname text := current_database();
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO metabase_ro', dbname);
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipping GRANT CONNECT for metabase_ro (run as superuser if needed).';
END$$;

GRANT USAGE ON SCHEMA reporting TO metabase_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO metabase_ro;

-- Persisted Insights / Metabase policy for Settings UI + API.
ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS insights_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN store_settings.insights_config IS
    'Insights: data_access_mode, staff_note_markdown, metabase_jwt_sso_enabled, jwt_email_domain — see GET/PATCH /api/settings/insights.';

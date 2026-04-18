-- Restore margin columns on reporting.order_lines after transaction-schema stabilization.
-- Keeps the view aligned with margin-pivot and migration status probes.

DROP VIEW IF EXISTS reporting.order_lines CASCADE;

DO $$
BEGIN
    -- Current schema path (post transactions refactor).
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'transaction_lines'
    ) THEN
        EXECUTE $v$
        CREATE VIEW reporting.order_lines AS
        SELECT
            tl.id AS line_id,
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
            tl.product_id,
            tl.variant_id,
            p.name AS product_name,
            pv.sku,
            t.customer_id,
            t.customer_name AS customer_display_name,
            t.customer_phone
        FROM transaction_lines tl
        JOIN reporting.transactions_core t ON t.transaction_id = tl.transaction_id
        LEFT JOIN products p ON p.id = tl.product_id
        LEFT JOIN product_variants pv ON pv.id = tl.variant_id
        $v$;

    -- Legacy schema path (pre transactions refactor).
    ELSIF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'order_items'
    ) THEN
        EXECUTE $v$
        CREATE VIEW reporting.order_lines AS
        SELECT
            oi.id AS line_id,
            oi.order_id,
            o.short_id AS order_short_id,
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
            NULL::uuid AS fulfillment_order_id,
            oi.product_id,
            oi.variant_id,
            p.name AS product_name,
            pv.sku,
            o.customer_id,
            TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
            c.phone AS customer_phone
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        CROSS JOIN LATERAL (
            SELECT reporting.order_recognition_at(
                o.id, o.fulfillment_method::text, o.status::text, o.fulfilled_at
            ) AS rec_at
        ) rec
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN products p ON p.id = oi.product_id
        LEFT JOIN product_variants pv ON pv.id = oi.variant_id
        $v$;
    END IF;
END $$;

COMMENT ON VIEW reporting.order_lines IS
    'Line grain with frozen unit_cost, line_extended_cost, and line_gross_margin_pre_tax for booked/fulfilled reporting.';

GRANT SELECT ON reporting.order_lines TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('150_reporting_order_lines_margin_restore.sql')
ON CONFLICT (version) DO NOTHING;

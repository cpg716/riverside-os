-- Migration 143: Metabase & Reporting Synchronization (Transactions vs. Fulfillment)
-- Updates the reporting schema to reflect the renamed tables and introduce logistical vs financial views.

-- 1. Update Recognition Function (Renames order_id to transaction_id to match schema)
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
            WHERE s.transaction_id = p_order_id -- Renamed in Mig 142
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

-- 2. Drop existing views for clean replacement (CASCADE handles dependencies)
DROP VIEW IF EXISTS reporting.daily_order_totals_recognized CASCADE;
DROP VIEW IF EXISTS reporting.daily_order_totals CASCADE;
DROP VIEW IF EXISTS reporting.order_lines CASCADE;
DROP VIEW IF EXISTS reporting.orders_core CASCADE;
DROP VIEW IF EXISTS reporting.orders_v1 CASCADE;
DROP VIEW IF EXISTS reporting.transactions_core CASCADE;
DROP VIEW IF EXISTS reporting.fulfillment_orders_core CASCADE;

-- 3. Core Transaction View (The Financial Truth)
CREATE OR REPLACE VIEW reporting.transactions_core AS
SELECT
    t.id AS transaction_id,
    t.display_id AS transaction_display_id,
    t.booked_at,
    (t.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS booked_business_date,
    rec.rec_at AS recognition_at,
    (rec.rec_at AT TIME ZONE reporting.effective_store_timezone())::date AS recognition_business_date,
    t.status::text AS status,
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
    t.sale_channel::text AS sale_channel,
    t.fulfillment_method::text AS fulfillment_method
FROM transactions t
CROSS JOIN LATERAL (
    SELECT reporting.order_recognition_at(
        t.id, t.fulfillment_method::text, t.status::text, t.fulfilled_at
    ) AS rec_at
) rec
LEFT JOIN customers c ON c.id = t.customer_id
LEFT JOIN staff op ON op.id = t.operator_id
LEFT JOIN staff sp ON sp.id = t.primary_salesperson_id;

COMMENT ON VIEW reporting.transactions_core IS 'Financial transaction grain: one row per checkout event. use recognition_* for realized revenue reporting.';

-- 4. Fulfillment View (The Logistical Truth)
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
    fo.notes
FROM fulfillment_orders fo
LEFT JOIN customers c ON c.id = fo.customer_id
LEFT JOIN wedding_parties wp ON wp.id = fo.wedding_id;

COMMENT ON VIEW reporting.fulfillment_orders_core IS 'Logistical grain: one row per physical order being procured/manufactured.';

-- 5. Legacy Shims (Maintains compatibility with existing Metabase dashboards)
CREATE OR REPLACE VIEW reporting.orders_core AS SELECT * FROM reporting.transactions_core;
CREATE OR REPLACE VIEW reporting.orders_v1 AS SELECT * FROM reporting.transactions_core;

CREATE OR REPLACE VIEW reporting.order_lines AS
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
    tl.fulfillment::text AS fulfillment,
    tl.is_fulfilled,
    tl.fulfillment_order_id,
    tl.product_id,
    tl.variant_id,
    p.name AS product_name,
    pv.sku,
    tl.unit_cost, -- Added for margin analysis
    t.customer_id,
    t.customer_name AS customer_display_name,
    t.customer_phone
FROM transaction_lines tl
JOIN reporting.transactions_core t ON t.transaction_id = tl.transaction_id
LEFT JOIN products p ON p.id = tl.product_id
LEFT JOIN product_variants pv ON pv.id = tl.variant_id;

-- 6. Financial Summary Shims
CREATE OR REPLACE VIEW reporting.daily_order_totals AS
SELECT
    booked_business_date AS order_business_date,
    COUNT(*)::bigint AS order_count,
    SUM(total_price) AS gross_total,
    SUM(amount_paid) AS amount_paid_total
FROM reporting.transactions_core
GROUP BY 1;

CREATE OR REPLACE VIEW reporting.daily_order_totals_recognized AS
SELECT
    recognition_business_date AS order_recognition_business_date,
    COUNT(*)::bigint AS completed_order_count,
    SUM(total_price) AS gross_total,
    SUM(amount_paid) AS amount_paid_total
FROM reporting.transactions_core
WHERE status <> 'cancelled' AND recognition_at IS NOT NULL
GROUP BY 1;

-- Finalize Permissions
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO metabase_ro; -- Ensure base table access

INSERT INTO ros_schema_migrations (version) VALUES ('143_reporting_transactions_stabilization.sql')
ON CONFLICT (version) DO NOTHING;

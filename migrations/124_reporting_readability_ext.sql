-- Migration 124: Extended Reporting Readability for Alterations and Shipments
-- Adds human-readable fields and operational status views for these domains.

-- 1. Alterations Reporting View
CREATE OR REPLACE VIEW reporting.alterations_active AS
SELECT
    ao.id AS alteration_id,
    LEFT(ao.linked_order_id::text, 8) AS order_short_id,
    ao.linked_order_id,
    ao.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name,
    c.phone AS customer_phone,
    ao.status::text AS status,
    ao.due_at,
    ao.created_at,
    ao.updated_at,
    -- Simple overdue logic: not picked up and due date is in the past
    CASE
        WHEN ao.status != 'picked_up' AND ao.due_at < CURRENT_DATE THEN true
        ELSE false
    END AS is_overdue
FROM alteration_orders ao
LEFT JOIN customers c ON c.id = ao.customer_id
ORDER BY ao.due_at ASC;

COMMENT ON VIEW reporting.alterations_active IS 'Active alterations with human-readable customer names and status flags. Not yet picked up.';

-- 2. Shipments Reporting View
CREATE OR REPLACE VIEW reporting.shipments_active AS
SELECT
    s.id AS shipment_id,
    s.source::text AS source,
    s.status::text AS status,
    LEFT(s.order_id::text, 8) AS order_short_id,
    s.order_id,
    s.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name,
    s.tracking_number,
    s.carrier,
    s.service_name,
    s.shipping_charged_usd,
    s.quoted_amount_usd,
    s.created_at
FROM shipment s
LEFT JOIN customers c ON c.id = s.customer_id
ORDER BY s.created_at DESC;

COMMENT ON VIEW reporting.shipments_active IS 'Detailed shipment history with joined customer identifiers and financial quotes.';

-- Re-grant access after potential drops or new creations
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('124_reporting_readability_ext.sql')
ON CONFLICT (version) DO NOTHING;

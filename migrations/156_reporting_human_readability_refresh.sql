-- Human-readability refresh for Metabase-facing reporting views.
-- Goal: preserve join-safe machine keys while making routine reporting readable by default.

DROP VIEW IF EXISTS reporting.alterations_active;
CREATE VIEW reporting.alterations_active AS
SELECT
    ao.id AS alteration_id,
    COALESCE(ao.transaction_id, ao.linked_transaction_id) AS order_id,
    COALESCE(t.display_id, t.short_id, LEFT(COALESCE(ao.transaction_id, ao.linked_transaction_id)::text, 8)) AS order_short_id,
    COALESCE(ao.transaction_id, ao.linked_transaction_id) AS transaction_id,
    t.display_id AS transaction_display_id,
    ao.fulfillment_order_id,
    fo.display_id AS fulfillment_order_display_id,
    ao.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    (ao.status)::text AS status,
    ao.due_at,
    ao.created_at,
    ao.updated_at,
    CASE
        WHEN (ao.status)::text <> 'picked_up' AND ao.due_at < CURRENT_DATE THEN true
        ELSE false
    END AS is_overdue
FROM alteration_orders ao
LEFT JOIN transactions t ON t.id = COALESCE(ao.transaction_id, ao.linked_transaction_id)
LEFT JOIN fulfillment_orders fo ON fo.id = ao.fulfillment_order_id
LEFT JOIN customers c ON c.id = ao.customer_id
WHERE (ao.status)::text <> 'picked_up';

COMMENT ON VIEW reporting.alterations_active IS
    'Active alterations with readable transaction, fulfillment, and customer labels. Keeps raw ids for drill-through.';

DROP VIEW IF EXISTS reporting.shipments_active;
CREATE VIEW reporting.shipments_active AS
SELECT
    s.id AS shipment_id,
    (s.source)::text AS source,
    (s.status)::text AS status,
    COALESCE(t.display_id, LEFT(s.transaction_id::text, 8)) AS order_short_id,
    s.transaction_id AS order_id,
    s.transaction_id,
    t.display_id AS transaction_display_id,
    s.fulfillment_order_id,
    fo.display_id AS fulfillment_order_display_id,
    s.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name,
    c.phone AS customer_phone,
    s.tracking_number,
    s.carrier,
    s.service_name,
    s.shipping_charged_usd,
    s.quoted_amount_usd,
    s.label_cost_usd,
    s.created_at,
    s.updated_at
FROM shipment s
LEFT JOIN transactions t ON t.id = s.transaction_id
LEFT JOIN fulfillment_orders fo ON fo.id = s.fulfillment_order_id
LEFT JOIN customers c ON c.id = s.customer_id
ORDER BY s.created_at DESC;

COMMENT ON VIEW reporting.shipments_active IS
    'Shipment activity with readable transaction and fulfillment display ids plus customer labels.';

DROP VIEW IF EXISTS reporting.merchant_reconciliation;
CREATE VIEW reporting.merchant_reconciliation AS
WITH allocation_rollup AS (
    SELECT
        pa.transaction_id AS payment_transaction_id,
        COUNT(DISTINCT pa.target_transaction_id) AS linked_transaction_count,
        MIN(pa.target_transaction_id::text) FILTER (WHERE pa.target_transaction_id IS NOT NULL) AS primary_transaction_id_text,
        MIN(tc.transaction_display_id) FILTER (WHERE tc.transaction_display_id IS NOT NULL) AS primary_transaction_display_id,
        STRING_AGG(DISTINCT tc.transaction_display_id, ', ' ORDER BY tc.transaction_display_id)
            FILTER (WHERE tc.transaction_display_id IS NOT NULL) AS linked_transaction_display_ids,
        STRING_AGG(DISTINCT COALESCE(tc.customer_name, 'Walk-in / Unknown'), ', ' ORDER BY COALESCE(tc.customer_name, 'Walk-in / Unknown'))
            FILTER (WHERE tc.transaction_id IS NOT NULL) AS linked_customer_names,
        MIN(tc.booked_at) FILTER (WHERE tc.transaction_id IS NOT NULL) AS revenue_recognition_date,
        MIN(COALESCE(tc.fulfilled_at, tc.booked_at)) FILTER (WHERE tc.transaction_id IS NOT NULL) AS tax_commission_basis_date
    FROM payment_allocations pa
    LEFT JOIN reporting.transactions_core tc ON tc.transaction_id = pa.target_transaction_id
    GROUP BY pa.transaction_id
)
SELECT
    pt.id AS transaction_id,
    pt.id AS payment_transaction_id,
    pt.occurred_at,
    pt.amount,
    pt.merchant_fee,
    pt.net_amount,
    pt.payment_method,
    NULLIF(ar.primary_transaction_id_text, '')::uuid AS order_id,
    ar.primary_transaction_display_id AS transaction_display_id,
    ar.primary_transaction_display_id,
    ar.linked_transaction_display_ids,
    ar.linked_transaction_count,
    ar.linked_customer_names,
    ar.revenue_recognition_date,
    ar.tax_commission_basis_date
FROM payment_transactions pt
LEFT JOIN allocation_rollup ar ON ar.payment_transaction_id = pt.id;

COMMENT ON VIEW reporting.merchant_reconciliation IS
    'Merchant settlement ledger with readable linked transaction ids and customer names for reconciliation work.';

DROP VIEW IF EXISTS reporting.payment_ledger;
CREATE VIEW reporting.payment_ledger AS
WITH allocation_rollup AS (
    SELECT
        pa.transaction_id AS payment_transaction_id,
        COUNT(DISTINCT pa.target_transaction_id) AS linked_transaction_count,
        MIN(pa.target_transaction_id::text) FILTER (WHERE pa.target_transaction_id IS NOT NULL) AS primary_transaction_id_text,
        MIN(tc.transaction_display_id) FILTER (WHERE tc.transaction_display_id IS NOT NULL) AS primary_transaction_display_id,
        STRING_AGG(DISTINCT tc.transaction_display_id, ', ' ORDER BY tc.transaction_display_id)
            FILTER (WHERE tc.transaction_display_id IS NOT NULL) AS linked_transaction_display_ids,
        STRING_AGG(DISTINCT COALESCE(tc.customer_name, 'Walk-in / Unknown'), ', ' ORDER BY COALESCE(tc.customer_name, 'Walk-in / Unknown'))
            FILTER (WHERE tc.transaction_id IS NOT NULL) AS linked_customer_names
    FROM payment_allocations pa
    LEFT JOIN reporting.transactions_core tc ON tc.transaction_id = pa.target_transaction_id
    GROUP BY pa.transaction_id
)
SELECT
    pt.id,
    pt.id AS payment_transaction_id,
    pt.created_at,
    pt.occurred_at,
    (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date AS business_date,
    (pt.category)::text AS category,
    pt.status,
    pt.payment_method,
    pt.check_number,
    pt.amount AS gross_amount,
    pt.merchant_fee,
    pt.net_amount,
    pt.card_brand,
    pt.card_last4,
    pt.stripe_intent_id,
    pt.payer_id,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS payer_name,
    c.customer_code AS payer_code,
    c.phone AS payer_phone,
    NULLIF(ar.primary_transaction_id_text, '')::uuid AS linked_transaction_id,
    ar.linked_transaction_count,
    ar.primary_transaction_display_id,
    ar.linked_transaction_display_ids,
    ar.linked_customer_names
FROM payment_transactions pt
LEFT JOIN customers c ON c.id = pt.payer_id
LEFT JOIN allocation_rollup ar ON ar.payment_transaction_id = pt.id;

COMMENT ON VIEW reporting.payment_ledger IS
    'Readable payment audit log with payer labels and linked transaction display ids for one-to-many allocations.';

DROP VIEW IF EXISTS reporting.wedding_party_economics;
CREATE VIEW reporting.wedding_party_economics AS
SELECT
    wp.id AS wedding_party_id,
    wp.party_name AS wedding_party_name,
    wp.event_date,
    wp.groom_name,
    wp.bride_name,
    wp.salesperson AS wedding_salesperson_name,
    COUNT(DISTINCT wm.id) AS member_count,
    COUNT(DISTINCT o.id) AS order_count,
    SUM((oi.quantity)::numeric * oi.unit_price) AS total_revenue,
    SUM((oi.quantity)::numeric * oi.unit_cost) AS total_cost,
    SUM((oi.quantity)::numeric * (oi.unit_price - oi.unit_cost)) AS total_profit,
    SUM(
        CASE
            WHEN wm.is_free_suit_promo THEN 1
            ELSE 0
        END
    ) AS free_suits_marked,
    CASE
        WHEN SUM((oi.quantity)::numeric * oi.unit_price) > 0
            THEN (SUM((oi.quantity)::numeric * (oi.unit_price - oi.unit_cost))
                / SUM((oi.quantity)::numeric * oi.unit_price)) * 100
        ELSE 0
    END AS margin_percent
FROM wedding_parties wp
LEFT JOIN wedding_members wm ON wm.wedding_party_id = wp.id
LEFT JOIN transactions o ON o.wedding_member_id = wm.id AND o.status <> 'cancelled'
LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
GROUP BY wp.id, wp.party_name, wp.event_date, wp.groom_name, wp.bride_name, wp.salesperson;

COMMENT ON VIEW reporting.wedding_party_economics IS
    'Wedding economics with readable party identity, event date, and coordinator labels.';

DROP VIEW IF EXISTS reporting.loyalty_point_ledger;
CREATE VIEW reporting.loyalty_point_ledger AS
SELECT
    l.id,
    l.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    l.delta_points,
    l.balance_after,
    l.reason,
    l.transaction_id AS order_id,
    l.transaction_id,
    t.display_id AS transaction_display_id,
    l.created_by_staff_id,
    s.full_name AS created_by_staff_name,
    l.metadata,
    l.created_at
FROM loyalty_point_ledger l
JOIN customers c ON c.id = l.customer_id
LEFT JOIN transactions t ON t.id = l.transaction_id
LEFT JOIN staff s ON s.id = l.created_by_staff_id;

COMMENT ON VIEW reporting.loyalty_point_ledger IS
    'Loyalty point movements with readable customer and transaction display labels.';

DROP VIEW IF EXISTS reporting.loyalty_reward_issuances;
CREATE VIEW reporting.loyalty_reward_issuances AS
SELECT
    lri.id,
    lri.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    lri.points_deducted,
    lri.reward_amount,
    lri.applied_to_sale,
    lri.remainder_card_id,
    lri.transaction_id AS order_id,
    lri.transaction_id,
    t.display_id AS transaction_display_id,
    lri.issued_by_staff_id,
    s.full_name AS issued_by_staff_name,
    lri.created_at
FROM loyalty_reward_issuances lri
JOIN customers c ON c.id = lri.customer_id
LEFT JOIN transactions t ON t.id = lri.transaction_id
LEFT JOIN staff s ON s.id = lri.issued_by_staff_id;

COMMENT ON VIEW reporting.loyalty_reward_issuances IS
    'Reward issuance ledger with readable customer and linked transaction display ids.';

DROP VIEW IF EXISTS reporting.order_loyalty_accrual;
CREATE VIEW reporting.order_loyalty_accrual AS
SELECT
    ola.transaction_id AS order_id,
    ola.transaction_id,
    t.display_id AS transaction_display_id,
    ola.points_earned,
    ola.product_subtotal,
    ola.created_at AS accrual_recorded_at,
    t.booked_at AS order_booked_at,
    (t.booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS order_business_date,
    (t.status)::text AS order_status,
    t.total_price,
    t.amount_paid,
    t.customer_id,
    c.customer_code,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state
FROM transaction_loyalty_accrual ola
JOIN transactions t ON t.id = ola.transaction_id
LEFT JOIN customers c ON c.id = t.customer_id;

COMMENT ON VIEW reporting.order_loyalty_accrual IS
    'Loyalty earn snapshots with readable transaction and customer fields for staff-friendly reporting.';

DROP VIEW IF EXISTS reporting.loyalty_customer_snapshot;
CREATE VIEW reporting.loyalty_customer_snapshot AS
SELECT
    c.id AS customer_id,
    c.customer_code,
    c.first_name,
    c.last_name,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_display_name,
    c.phone,
    c.email,
    c.loyalty_points AS current_balance,
    COALESCE(SUM(lpl.delta_points) FILTER (WHERE lpl.delta_points > 0 AND lpl.reason = 'order_earn'), 0) AS lifetime_earned_from_orders,
    COALESCE(SUM(lpl.delta_points) FILTER (WHERE lpl.delta_points < 0 AND lpl.reason = 'reward_redemption'), 0) * -1 AS lifetime_points_redeemed,
    COALESCE(SUM(lpl.delta_points) FILTER (WHERE lpl.reason = 'manual_adjust'), 0) AS net_manual_adjustments,
    COALESCE(COUNT(lri.id), 0) AS rewards_issued_count,
    COALESCE(SUM(lri.reward_amount), 0) AS total_reward_dollars_issued
FROM customers c
LEFT JOIN loyalty_point_ledger lpl ON c.id = lpl.customer_id
LEFT JOIN loyalty_reward_issuances lri ON c.id = lri.customer_id
GROUP BY c.id, c.customer_code, c.first_name, c.last_name, c.phone, c.email, c.loyalty_points;

COMMENT ON VIEW reporting.loyalty_customer_snapshot IS
    'Customer loyalty snapshot with a unified customer_display_name for easy reporting.';

GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('156_reporting_human_readability_refresh.sql')
ON CONFLICT (version) DO NOTHING;

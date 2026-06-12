-- Riverside OS production hardening audit probes.
--
-- Read-only checks for retail go/no-go review. These queries should return zero rows
-- unless the SELECT explicitly returns a summary count. Do not run repair statements from
-- this file; investigate any non-zero result with engineering/accounting before deployment.

\echo 'P0/P1 probe: duplicate checkout_client_id transactions'
SELECT checkout_client_id, COUNT(*) AS transaction_count
FROM transactions
WHERE checkout_client_id IS NOT NULL
GROUP BY checkout_client_id
HAVING COUNT(*) > 1
ORDER BY transaction_count DESC, checkout_client_id;

\echo 'P0/P1 probe: payment allocations referencing missing payment transactions'
SELECT pa.id, pa.transaction_id, pa.target_transaction_id, pa.amount_allocated
FROM payment_allocations pa
LEFT JOIN payment_transactions pt ON pt.id = pa.transaction_id
WHERE pt.id IS NULL
ORDER BY pa.id;

\echo 'P0/P1 probe: payment allocations referencing missing retail transactions'
SELECT pa.id, pa.transaction_id, pa.target_transaction_id, pa.amount_allocated
FROM payment_allocations pa
LEFT JOIN transactions t ON t.id = pa.target_transaction_id
WHERE t.id IS NULL
ORDER BY pa.id;

\echo 'P1 probe: payment allocations that over-allocate a payment transaction'
SELECT
    pt.id AS payment_transaction_id,
    pt.amount AS payment_amount,
    COALESCE(SUM(pa.amount_allocated), 0)::numeric(14, 2) AS allocated_amount,
    (ABS(COALESCE(SUM(pa.amount_allocated), 0)) - ABS(pt.amount))::numeric(14, 2) AS overage
FROM payment_transactions pt
LEFT JOIN payment_allocations pa ON pa.transaction_id = pt.id
GROUP BY pt.id, pt.amount
HAVING ABS(COALESCE(SUM(pa.amount_allocated), 0)) > ABS(pt.amount) + 0.01
ORDER BY overage DESC;

\echo 'P1 probe: register sessions still reconciling for more than 2 hours'
SELECT id, register_lane, till_close_group_id, opened_at, lifecycle_status
FROM register_sessions
WHERE is_open = true
  AND lifecycle_status = 'reconciling'
  AND opened_at < now() - INTERVAL '2 hours'
ORDER BY opened_at;

\echo 'P1 probe: open server-backed parked sales on closed register sessions'
SELECT p.id, p.register_session_id, rs.till_close_group_id, p.label, p.created_at
FROM pos_parked_sale p
JOIN register_sessions rs ON rs.id = p.register_session_id
WHERE p.status = 'parked'
  AND rs.is_open = false
ORDER BY p.created_at DESC;

\echo 'P1 probe: negative available stock by variant'
SELECT
    pv.id AS variant_id,
    pv.sku,
    pv.stock_on_hand,
    pv.reserved_stock,
    pv.on_layaway,
    (pv.stock_on_hand - pv.reserved_stock - pv.on_layaway) AS available_stock
FROM product_variants pv
JOIN products p ON p.id = pv.product_id
WHERE (pv.stock_on_hand - pv.reserved_stock - pv.on_layaway) < 0
  AND COALESCE(p.pos_line_kind, '') = ''
ORDER BY available_stock ASC, pv.sku;

\echo 'P1 probe: order-style checkout lines that decremented stock at booking'
SELECT it.id, it.variant_id, it.reference_table, it.reference_id, it.tx_type, it.quantity_delta, it.created_at
FROM inventory_transactions it
JOIN transaction_lines tl ON tl.id = it.reference_id
WHERE tl.fulfillment::text IN ('special_order', 'custom', 'wedding_order', 'layaway')
  AND it.tx_type::text IN ('sale', 'fulfillment')
  AND it.quantity_delta < 0
  AND tl.fulfilled_at IS NULL
  AND it.reference_table = 'transaction_lines'
ORDER BY it.created_at DESC;

\echo 'P1 probe: taxable transaction lines with tax-exempt flag but missing reason'
SELECT tl.id, tl.transaction_id, tl.product_id, tl.unit_price, tl.state_tax, tl.local_tax
FROM transaction_lines tl
JOIN transactions t ON t.id = tl.transaction_id
WHERE COALESCE(t.is_tax_exempt, false) = true
  AND NULLIF(TRIM(COALESCE(t.tax_exempt_reason, '')), '') IS NULL
  AND (COALESCE(tl.state_tax, 0) <> 0 OR COALESCE(tl.local_tax, 0) <> 0)
ORDER BY t.booked_at DESC;

\echo 'P1 probe: finalized commission lines without fulfillment recognition'
SELECT id, transaction_id, salesperson_id, fulfilled_at, commission_payout_finalized_at
FROM transaction_lines
WHERE commission_payout_finalized_at IS NOT NULL
  AND fulfilled_at IS NULL
ORDER BY commission_payout_finalized_at DESC;

\echo 'P1 probe: approved/pending QBO staging rows with unbalanced payload totals'
SELECT
    id,
    sync_date,
    status,
    payload #>> '{totals,debits}' AS debits,
    payload #>> '{totals,credits}' AS credits,
    payload #>> '{totals,balanced}' AS balanced
FROM qbo_sync_logs
WHERE status IN ('pending', 'approved')
  AND COALESCE((payload #>> '{totals,balanced}')::boolean, false) = false
ORDER BY sync_date DESC, created_at DESC;

\echo 'P1 probe: QBO staging rows missing business_timezone after store-local date hardening'
SELECT id, sync_date, status, created_at
FROM qbo_sync_logs
WHERE payload ? 'activity_date'
  AND NOT (payload ? 'business_timezone')
ORDER BY created_at DESC
LIMIT 50;

\echo 'P1 probe: receiving events with freight missing inventory receipt rows'
SELECT
    re.id AS receiving_event_id,
    re.purchase_order_id,
    re.invoice_number,
    re.freight_total,
    re.received_at
FROM receiving_events re
LEFT JOIN inventory_transactions it
    ON it.reference_table = 'receiving_events'
   AND it.reference_id = re.id
   AND it.tx_type::text = 'po_receipt'
WHERE COALESCE(re.freight_total, 0) > 0
GROUP BY re.id, re.purchase_order_id, re.invoice_number, re.freight_total, re.received_at
HAVING COUNT(it.id) = 0
ORDER BY re.received_at DESC;

\echo 'P1 probe: supplier freight captured on receipts for accounting review'
SELECT
    'supplier_freight_receipts' AS metric,
    COUNT(*)::text AS receipt_count,
    COALESCE(SUM(re.freight_total), 0)::numeric(14, 2)::text AS supplier_freight_total
FROM receiving_events re
WHERE COALESCE(re.freight_total, 0) > 0;

\echo 'P1 probe: shipped customer transactions missing shipping registry rows'
SELECT
    t.id AS transaction_id,
    t.display_id,
    t.shipping_amount_usd,
    t.booked_at,
    t.fulfilled_at
FROM transactions t
LEFT JOIN shipment s ON s.transaction_id = t.id
WHERE t.fulfillment_method::text = 'ship'
  AND COALESCE(t.shipping_amount_usd, 0) > 0
  AND s.id IS NULL
ORDER BY t.booked_at DESC;

\echo 'P1 probe: customer shipping charges accidentally stored as supplier freight'
SELECT
    q.id AS qbo_sync_log_id,
    q.sync_date,
    q.status,
    line.value->>'memo' AS memo,
    detail.value->>'kind' AS detail_kind
FROM qbo_sync_logs q
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(q.payload->'lines', '[]'::jsonb)) AS line(value)
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(line.value->'detail', '[]'::jsonb)) AS detail(value)
WHERE (
        line.value->>'memo' = 'Customer-charged shipping income'
        AND detail.value->>'kind' = 'freight'
    )
   OR (
        line.value->>'memo' LIKE 'Inbound freight / shipping cost%'
        AND detail.value->>'kind' = 'shipping_income'
    )
ORDER BY q.sync_date DESC, q.created_at DESC;

\echo 'P1 probe: QBO payloads that combine receiving and freight into one detail line'
SELECT
    q.id AS qbo_sync_log_id,
    q.sync_date,
    q.status,
    line.value->>'memo' AS memo,
    detail.value AS detail
FROM qbo_sync_logs q
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(q.payload->'lines', '[]'::jsonb)) AS line(value)
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(line.value->'detail', '[]'::jsonb)) AS detail(value)
WHERE line.value->>'memo' LIKE 'Receiving:%'
  AND detail.value->>'kind' = 'freight'
ORDER BY q.sync_date DESC, q.created_at DESC;

\echo 'P1 probe: stale backup health'
SELECT
    id,
    last_local_success_at,
    last_local_failure_at,
    last_cloud_success_at,
    last_cloud_failure_at,
    updated_at
FROM store_backup_health
WHERE last_local_success_at IS NULL
   OR last_local_success_at < now() - INTERVAL '30 hours'
   OR COALESCE(last_local_failure_at, '-infinity'::timestamptz) > COALESCE(last_local_success_at, '-infinity'::timestamptz);

\echo 'Summary: open register, parked sale, QBO staging, backup state'
SELECT 'open_register_sessions' AS metric, COUNT(*)::text AS value
FROM register_sessions
WHERE is_open = true
UNION ALL
SELECT 'open_parked_sales' AS metric, COUNT(*)::text AS value
FROM pos_parked_sale
WHERE status = 'parked'
UNION ALL
SELECT 'pending_or_approved_qbo_staging' AS metric, COUNT(*)::text AS value
FROM qbo_sync_logs
WHERE status IN ('pending', 'approved')
UNION ALL
SELECT 'last_local_backup_success_at' AS metric, COALESCE(MAX(last_local_success_at)::text, 'never') AS value
FROM store_backup_health;

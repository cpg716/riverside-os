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
WHERE COALESCE(pt.status, '') <> 'canceled'
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

\echo 'P1 probe: inactive products that still carry inventory commitments'
SELECT
    p.id AS product_id,
    p.name AS product_name,
    COALESCE(SUM(pv.stock_on_hand), 0)::int4 AS stock_on_hand,
    COALESCE(SUM(pv.reserved_stock), 0)::int4 AS reserved_stock,
    COALESCE(SUM(pv.on_layaway), 0)::int4 AS on_layaway
FROM products p
JOIN product_variants pv ON pv.product_id = p.id
WHERE COALESCE(p.is_active, true) = false
GROUP BY p.id, p.name
HAVING COALESCE(SUM(pv.stock_on_hand), 0) <> 0
    OR COALESCE(SUM(pv.reserved_stock), 0) <> 0
    OR COALESCE(SUM(pv.on_layaway), 0) <> 0
ORDER BY p.name;

\echo 'P1 probe: manual inventory movements missing meaningful notes'
SELECT
    it.id,
    it.variant_id,
    pv.sku,
    it.tx_type,
    it.quantity_delta,
    it.created_at,
    it.created_by
FROM inventory_transactions it
JOIN product_variants pv ON pv.id = it.variant_id
WHERE it.tx_type::text IN ('adjustment', 'damaged', 'return_to_vendor')
  AND NULLIF(TRIM(COALESCE(it.notes, '')), '') IS NULL
ORDER BY it.created_at DESC;

\echo 'P1 probe: Counterpoint-linked variants with stock but no inventory movement ledger'
SELECT
    pv.id AS variant_id,
    pv.sku,
    pv.counterpoint_item_key,
    pv.stock_on_hand,
    pv.reserved_stock,
    pv.on_layaway
FROM product_variants pv
JOIN products p ON p.id = pv.product_id
WHERE pv.counterpoint_item_key IS NOT NULL
  AND COALESCE(pv.stock_on_hand, 0) <> 0
  AND NOT EXISTS (
      SELECT 1
      FROM inventory_transactions it
      WHERE it.variant_id = pv.id
  )
  AND COALESCE(p.pos_line_kind, '') = ''
ORDER BY pv.sku
LIMIT 500;

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

\echo 'P1 probe: discounted lines missing override evidence'
SELECT
    tl.id AS transaction_line_id,
    tl.transaction_id,
    t.display_id,
    tl.variant_id,
    tl.quantity,
    tl.unit_price,
    tl.size_specs
FROM transaction_lines tl
JOIN transactions t ON t.id = tl.transaction_id
WHERE t.status::text <> 'cancelled'
  AND (
      tl.size_specs ? 'discount_event_label'
      OR tl.size_specs ? 'discount_event_id'
      OR tl.size_specs ? 'price_override_reason'
  )
  AND (
      NOT (tl.size_specs ? 'original_unit_price')
      OR NOT (tl.size_specs ? 'overridden_unit_price')
      OR NULLIF(TRIM(tl.size_specs->>'original_unit_price'), '') IS NULL
      OR NULLIF(TRIM(tl.size_specs->>'overridden_unit_price'), '') IS NULL
  )
ORDER BY t.booked_at DESC;

\echo 'P1 probe: sale discount event metadata missing usage ledger'
SELECT
    tl.id AS transaction_line_id,
    tl.transaction_id,
    t.display_id,
    tl.variant_id,
    tl.size_specs->>'discount_event_id' AS discount_event_id
FROM transaction_lines tl
JOIN transactions t ON t.id = tl.transaction_id
WHERE t.status::text <> 'cancelled'
  AND NULLIF(TRIM(tl.size_specs->>'discount_event_id'), '') IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM discount_event_usage deu
      WHERE deu.order_item_id = tl.id
        AND deu.transaction_id = tl.transaction_id
        AND deu.variant_id = tl.variant_id
  )
ORDER BY t.booked_at DESC;

\echo 'P1 probe: discount usage ledger points at mismatched line facts'
SELECT
    deu.id AS discount_usage_id,
    deu.event_id,
    deu.transaction_id AS usage_transaction_id,
    tl.transaction_id AS line_transaction_id,
    deu.order_item_id AS transaction_line_id,
    deu.variant_id AS usage_variant_id,
    tl.variant_id AS line_variant_id,
    deu.quantity AS usage_quantity,
    tl.quantity AS line_quantity
FROM discount_event_usage deu
LEFT JOIN transaction_lines tl ON tl.id = deu.order_item_id
LEFT JOIN transactions t ON t.id = deu.transaction_id
WHERE tl.id IS NULL
   OR t.id IS NULL
   OR tl.transaction_id <> deu.transaction_id
   OR tl.variant_id <> deu.variant_id
   OR tl.quantity <> deu.quantity
ORDER BY deu.created_at DESC;

\echo 'P1 probe: customer profile discounts without matching customer profile'
SELECT
    tl.id AS transaction_line_id,
    tl.transaction_id,
    t.display_id,
    t.customer_id AS financial_customer_id,
    discount_source.discount_customer_id AS profile_discount_customer_id,
    c.profile_discount_percent,
    tl.size_specs
FROM transaction_lines tl
JOIN transactions t ON t.id = tl.transaction_id
LEFT JOIN LATERAL (
    SELECT CASE
        WHEN NULLIF(TRIM(tl.size_specs->>'profile_discount_customer_id'), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (tl.size_specs->>'profile_discount_customer_id')::uuid
        ELSE t.customer_id
    END AS discount_customer_id
) discount_source ON TRUE
LEFT JOIN customers c ON c.id = discount_source.discount_customer_id
WHERE t.status::text <> 'cancelled'
  AND lower(COALESCE(tl.size_specs->>'price_override_reason', '')) = 'customer profile discount'
  AND (
      discount_source.discount_customer_id IS NULL
      OR COALESCE(c.profile_discount_percent, 0) <= 0
  )
ORDER BY t.booked_at DESC;

\echo 'P1 probe: employee purchase transactions without linked employee customer'
SELECT
    t.id AS transaction_id,
    t.display_id,
    t.customer_id AS financial_customer_id,
    employee_source.employee_customer_id,
    t.booked_at
FROM transactions t
LEFT JOIN LATERAL (
    SELECT CASE
        WHEN NULLIF(TRIM(t.metadata->>'selected_customer_id'), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (t.metadata->>'selected_customer_id')::uuid
        ELSE t.customer_id
    END AS employee_customer_id
) employee_source ON TRUE
WHERE COALESCE(t.is_employee_purchase, false) = true
  AND t.status::text <> 'cancelled'
  AND NOT EXISTS (
      SELECT 1
      FROM staff s
      WHERE s.employee_customer_id = employee_source.employee_customer_id
  )
ORDER BY t.booked_at DESC;

\echo 'P1 probe: finalized commission lines without fulfillment recognition'
SELECT id, transaction_id, salesperson_id, fulfilled_at, commission_payout_finalized_at
FROM transaction_lines
WHERE commission_payout_finalized_at IS NOT NULL
  AND fulfilled_at IS NULL
ORDER BY commission_payout_finalized_at DESC;

\echo 'P1 probe: fulfilled commissionable lines missing commission event'
SELECT
    tl.id AS transaction_line_id,
    tl.transaction_id,
    t.display_id,
    tl.salesperson_id,
    tl.calculated_commission,
    COALESCE(tl.fulfilled_at, t.fulfilled_at, t.booked_at) AS recognition_at
FROM transaction_lines tl
JOIN transactions t ON t.id = tl.transaction_id
WHERE t.status::text <> 'cancelled'
  AND COALESCE(tl.is_fulfilled, false) = true
  AND tl.salesperson_id IS NOT NULL
  AND COALESCE(tl.calculated_commission, 0) <> 0
  AND NOT EXISTS (
      SELECT 1
      FROM commission_events ce
      WHERE ce.transaction_line_id = tl.id
        AND ce.event_type IN ('sale_commission', 'combo_incentive')
  )
ORDER BY recognition_at DESC;

\echo 'P1 probe: duplicate commission events for one source'
SELECT
    source_event_id,
    event_type,
    COUNT(*) AS event_count,
    COALESCE(SUM(total_commission_amount), 0)::numeric(14, 2) AS total_commission_amount
FROM commission_events
WHERE source_event_id IS NOT NULL
GROUP BY source_event_id, event_type
HAVING COUNT(*) > 1
ORDER BY event_count DESC, source_event_id;

\echo 'P1 probe: sale commission event totals disagree with transaction line snapshot'
SELECT
    ce.id AS commission_event_id,
    ce.transaction_line_id,
    ce.event_type,
    ce.total_commission_amount,
    tl.calculated_commission
FROM commission_events ce
JOIN transaction_lines tl ON tl.id = ce.transaction_line_id
JOIN transactions t ON t.id = tl.transaction_id
WHERE ce.event_type IN ('sale_commission', 'combo_incentive')
  AND t.status::text <> 'cancelled'
  AND ABS(COALESCE(ce.total_commission_amount, 0) - COALESCE(tl.calculated_commission, 0)) > 0.01
ORDER BY ce.event_at DESC;

\echo 'P1 probe: returned commissionable lines missing return adjustment event'
SELECT
    trl.id AS return_line_id,
    trl.transaction_id,
    t.display_id,
    trl.transaction_line_id,
    trl.quantity_returned,
    tl.calculated_commission
FROM transaction_return_lines trl
JOIN transaction_lines tl ON tl.id = trl.transaction_line_id
JOIN transactions t ON t.id = trl.transaction_id
WHERE t.status::text <> 'cancelled'
  AND tl.salesperson_id IS NOT NULL
  AND COALESCE(tl.calculated_commission, 0) > 0
  AND NOT EXISTS (
      SELECT 1
      FROM commission_events ce
      WHERE ce.source_event_id = trl.id
        AND ce.event_type = 'return_adjustment'
  )
ORDER BY trl.created_at DESC;

\echo 'P1 probe: approved QBO staging rows with unbalanced payload totals'
SELECT
    id,
    sync_date,
    status,
    payload #>> '{totals,debits}' AS debits,
    payload #>> '{totals,credits}' AS credits,
    payload #>> '{totals,balanced}' AS balanced
FROM qbo_sync_logs
WHERE status = 'approved'
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

\set ON_ERROR_STOP on
\pset pager off

-- Counterpoint real-data test run audit probes.
-- Read-only evidence pack for a staging clone loaded from real Counterpoint data.
-- Run through scripts/audit_counterpoint_real_data_test_run.sh so audit_date is set.

BEGIN READ ONLY;

\echo ''
\echo 'Counterpoint Real-Data Test Run Evidence Pack'
SELECT 'audit_date' AS metric, :'audit_date'::date::text AS value
UNION ALL SELECT 'generated_at', now()::text
UNION ALL SELECT 'database', current_database()
UNION ALL SELECT 'transaction_read_only', current_setting('transaction_read_only');

\echo ''
\echo '0. External-system safety guard'
SELECT
    COUNT(*) FILTER (WHERE is_active) AS active_qbo_integrations,
    COUNT(*) FILTER (WHERE is_active AND use_sandbox) AS active_qbo_sandbox_integrations,
    COUNT(*) FILTER (WHERE is_active AND NOT use_sandbox) AS active_qbo_live_integrations
FROM qbo_integration;

SELECT
    payment_provider,
    provider_terminal_id,
    COUNT(*) AS payment_rows,
    ROUND(COALESCE(SUM(amount), 0), 2) AS amount_sum
FROM payment_transactions
WHERE occurred_at::date = :'audit_date'::date
  AND payment_provider IS NOT NULL
GROUP BY payment_provider, provider_terminal_id
ORDER BY payment_rows DESC, payment_provider, provider_terminal_id;

\echo ''
\echo '1. Bridge-to-ROS ingestion completeness'
WITH staging AS (
    SELECT
        entity,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_batches,
        COALESCE(SUM(row_count) FILTER (WHERE status = 'pending'), 0) AS pending_rows,
        COUNT(*) FILTER (WHERE status = 'applying') AS applying_batches,
        COALESCE(SUM(row_count) FILTER (WHERE status = 'applying'), 0) AS applying_rows,
        COUNT(*) FILTER (WHERE status = 'applied') AS applied_batches,
        COALESCE(SUM(row_count) FILTER (WHERE status = 'applied'), 0) AS applied_rows,
        COUNT(*) FILTER (WHERE status = 'discarded') AS discarded_batches,
        COALESCE(SUM(row_count) FILTER (WHERE status = 'discarded'), 0) AS discarded_rows,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_batches,
        COALESCE(SUM(row_count) FILTER (WHERE status = 'failed'), 0) AS failed_rows,
        MAX(created_at) AS latest_staged_at
    FROM counterpoint_staging_batch
    GROUP BY entity
)
SELECT
    COALESCE(r.entity, s.entity) AS entity,
    COALESCE(r.records_processed, 0) AS bridge_reported_rows,
    s.pending_rows,
    s.applying_rows,
    s.applied_rows,
    s.discarded_rows,
    s.failed_rows,
    r.last_ok_at,
    r.last_error,
    s.latest_staged_at
FROM counterpoint_sync_runs r
FULL OUTER JOIN staging s ON s.entity = r.entity
ORDER BY COALESCE(r.entity, s.entity);

\echo 'Expected zero rows: bridge-reported rows with no staging/apply or landed ROS proof'
WITH staging AS (
    SELECT entity, COALESCE(SUM(row_count), 0) AS staged_rows
    FROM counterpoint_staging_batch
    WHERE status IN ('pending', 'applying', 'applied')
    GROUP BY entity
),
landed AS (
    SELECT 'customers'::text AS entity, COUNT(*)::bigint AS landed_rows FROM customers WHERE customer_created_source = 'counterpoint'
    UNION ALL SELECT 'staff', COUNT(*)::bigint FROM staff WHERE data_source = 'counterpoint'
    UNION ALL SELECT 'catalog', COUNT(*)::bigint FROM products WHERE data_source = 'counterpoint'
    UNION ALL SELECT 'inventory', COUNT(*)::bigint FROM product_variants WHERE NULLIF(TRIM(counterpoint_item_key), '') IS NOT NULL
    UNION ALL SELECT 'gift_cards', COUNT(*)::bigint FROM gift_cards
    UNION ALL SELECT 'store_credit_opening', COUNT(*)::bigint FROM store_credit_ledger WHERE reason = 'counterpoint_opening_balance'
    UNION ALL SELECT 'loyalty_hist', COUNT(*)::bigint FROM customers WHERE customer_created_source = 'counterpoint' AND COALESCE(loyalty_points, 0) <> 0
    UNION ALL SELECT 'tickets', COUNT(*)::bigint FROM transactions WHERE counterpoint_ticket_ref IS NOT NULL
    UNION ALL SELECT 'open_docs', COUNT(*)::bigint FROM transactions WHERE counterpoint_doc_ref IS NOT NULL
    UNION ALL SELECT 'receiving', COUNT(*)::bigint FROM counterpoint_receiving_history
)
SELECT
    r.entity,
    r.records_processed AS bridge_reported_rows,
    COALESCE(s.staged_rows, 0) AS staged_or_applied_rows,
    COALESCE(l.landed_rows, 0) AS landed_rows,
    r.last_ok_at
FROM counterpoint_sync_runs r
LEFT JOIN staging s ON s.entity = r.entity
LEFT JOIN landed l ON l.entity = r.entity
WHERE COALESCE(r.records_processed, 0) > 0
  AND COALESCE(s.staged_rows, 0) = 0
  AND COALESCE(l.landed_rows, 0) = 0
ORDER BY r.entity;

SELECT entity, severity, resolved, COUNT(*) AS issue_count
FROM counterpoint_sync_issue
GROUP BY entity, severity, resolved
ORDER BY resolved, severity DESC, entity;

SELECT ingest_type, severity, COUNT(*) AS quarantined_rows
FROM counterpoint_ingest_quarantine
GROUP BY ingest_type, severity
ORDER BY ingest_type, severity;

\echo ''
\echo '2. Counterpoint sync wizard progression gates'
SELECT status, COUNT(*) AS batch_count, COALESCE(SUM(row_count), 0) AS row_count
FROM counterpoint_staging_batch
GROUP BY status
ORDER BY status;

SELECT id, entity, row_count, status, apply_started_at, apply_error, recovered_at, recovery_reason
FROM counterpoint_staging_batch
WHERE status IN ('pending', 'applying', 'failed')
ORDER BY created_at DESC
LIMIT 50;

\echo 'Expected zero rows: stale applying batches'
SELECT id, entity, row_count, apply_started_at, apply_claimed_by_staff_id
FROM counterpoint_staging_batch
WHERE status = 'applying'
  AND apply_started_at < now() - interval '15 minutes'
ORDER BY apply_started_at;

\echo ''
\echo '3. Post-sync operational smoke readiness'
SELECT
    COUNT(DISTINCT p.id) AS counterpoint_products,
    COUNT(pv.id) AS counterpoint_variants,
    COUNT(*) FILTER (WHERE p.is_active) AS active_variant_rows,
    COUNT(*) FILTER (WHERE NULLIF(TRIM(pv.sku), '') IS NOT NULL) AS variants_with_sku,
    COUNT(*) FILTER (WHERE NULLIF(TRIM(pv.barcode), '') IS NOT NULL) AS variants_with_barcode,
    COUNT(*) FILTER (WHERE COALESCE(pv.retail_price_override, p.base_retail_price) >= 0) AS variants_with_nonnegative_price,
    COUNT(*) FILTER (WHERE COALESCE(pv.cost_override, p.base_cost) >= 0) AS variants_with_nonnegative_cost
FROM products p
LEFT JOIN product_variants pv ON pv.product_id = p.id
WHERE p.data_source = 'counterpoint'
   OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL;

SELECT
    p.id AS product_id,
    p.name,
    p.is_active,
    p.tax_category,
    pv.id AS variant_id,
    pv.sku,
    pv.barcode,
    pv.counterpoint_item_key,
    COALESCE(pv.retail_price_override, p.base_retail_price) AS sell_price,
    pv.stock_on_hand,
    pv.reserved_stock,
    pv.on_layaway,
    (COALESCE(pv.stock_on_hand, 0) - COALESCE(pv.reserved_stock, 0) - COALESCE(pv.on_layaway, 0)) AS available_stock
FROM products p
JOIN product_variants pv ON pv.product_id = p.id
WHERE p.data_source = 'counterpoint'
   OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL
ORDER BY p.name, pv.sku
LIMIT 50;

\echo 'Expected zero rows: imported sellable variants missing core POS fields'
SELECT p.id AS product_id, p.name, pv.id AS variant_id, pv.sku, pv.barcode, COALESCE(pv.retail_price_override, p.base_retail_price) AS sell_price
FROM products p
JOIN product_variants pv ON pv.product_id = p.id
WHERE (p.data_source = 'counterpoint' OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL)
  AND (
      NOT COALESCE(p.is_active, false)
      OR NULLIF(TRIM(pv.sku), '') IS NULL
      OR COALESCE(pv.retail_price_override, p.base_retail_price) < 0
  )
ORDER BY p.name, pv.sku
LIMIT 100;

SELECT
    COUNT(*) FILTER (WHERE customer_created_source = 'counterpoint') AS counterpoint_customers,
    COUNT(*) FILTER (WHERE customer_created_source = 'counterpoint' AND NULLIF(TRIM(email), '') IS NOT NULL) AS counterpoint_customers_with_email,
    COUNT(*) FILTER (WHERE customer_created_source = 'counterpoint' AND NULLIF(TRIM(phone), '') IS NOT NULL) AS counterpoint_customers_with_phone
FROM customers;

SELECT
    COUNT(*) AS vendor_rows_with_codes,
    COUNT(*) FILTER (WHERE NULLIF(TRIM(vendor_code), '') IS NOT NULL) AS vendors_with_vendor_code
FROM vendors;

\echo ''
\echo '4. Audit, rollback, and reconciliation proof'
SELECT status, COUNT(*) AS batch_count, COALESCE(SUM(row_count), 0) AS row_count, MIN(created_at) AS oldest_at, MAX(created_at) AS newest_at
FROM counterpoint_staging_batch
GROUP BY status
ORDER BY status;

SELECT entity, severity, COUNT(*) AS unresolved_issue_count, MIN(created_at) AS oldest_issue_at, MAX(created_at) AS newest_issue_at
FROM counterpoint_sync_issue
WHERE resolved = false
GROUP BY entity, severity
ORDER BY severity DESC, entity;

SELECT id, requested_at, entity, acked_at, completed_at, error_message
FROM counterpoint_sync_request
ORDER BY requested_at DESC
LIMIT 50;

\echo 'Expected zero rows: duplicate Counterpoint ticket or open-doc references'
SELECT 'ticket' AS ref_type, counterpoint_ticket_ref AS ref, COUNT(*) AS row_count
FROM transactions
WHERE counterpoint_ticket_ref IS NOT NULL
GROUP BY counterpoint_ticket_ref
HAVING COUNT(*) > 1
UNION ALL
SELECT 'open_doc' AS ref_type, counterpoint_doc_ref AS ref, COUNT(*) AS row_count
FROM transactions
WHERE counterpoint_doc_ref IS NOT NULL
GROUP BY counterpoint_doc_ref
HAVING COUNT(*) > 1
ORDER BY ref_type, row_count DESC, ref;

\echo ''
\echo '5. POS sale flow with Counterpoint-ingested items'
WITH imported_sales AS (
    SELECT DISTINCT t.id
    FROM transactions t
    JOIN transaction_lines tl ON tl.transaction_id = t.id
    LEFT JOIN products p ON p.id = tl.product_id
    LEFT JOIN product_variants pv ON pv.id = tl.variant_id
    WHERE COALESCE(t.booked_at, t.created_at)::date = :'audit_date'::date
      AND t.is_counterpoint_import = false
      AND (p.data_source = 'counterpoint' OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL)
)
SELECT
    COUNT(*) AS imported_item_sale_count,
    ROUND(COALESCE(SUM(t.total_price), 0), 2) AS total_price_sum,
    ROUND(COALESCE(SUM(t.amount_paid), 0), 2) AS amount_paid_sum,
    ROUND(COALESCE(SUM(t.balance_due), 0), 2) AS balance_due_sum
FROM imported_sales s
JOIN transactions t ON t.id = s.id;

WITH imported_sales AS (
    SELECT DISTINCT t.id
    FROM transactions t
    JOIN transaction_lines tl ON tl.transaction_id = t.id
    LEFT JOIN products p ON p.id = tl.product_id
    LEFT JOIN product_variants pv ON pv.id = tl.variant_id
    WHERE COALESCE(t.booked_at, t.created_at)::date = :'audit_date'::date
      AND t.is_counterpoint_import = false
      AND (p.data_source = 'counterpoint' OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL)
)
SELECT pt.payment_method, COUNT(*) AS payment_rows, ROUND(COALESCE(SUM(pa.amount_allocated), 0), 2) AS allocated_sum
FROM imported_sales s
JOIN payment_allocations pa ON pa.target_transaction_id = s.id
JOIN payment_transactions pt ON pt.id = pa.transaction_id
GROUP BY pt.payment_method
ORDER BY pt.payment_method;

SELECT
    t.id,
    t.display_id,
    t.status,
    t.total_price,
    t.amount_paid,
    t.balance_due,
    t.register_session_id,
    COUNT(tl.id) AS line_count
FROM transactions t
JOIN transaction_lines tl ON tl.transaction_id = t.id
LEFT JOIN products p ON p.id = tl.product_id
LEFT JOIN product_variants pv ON pv.id = tl.variant_id
WHERE COALESCE(t.booked_at, t.created_at)::date = :'audit_date'::date
  AND t.is_counterpoint_import = false
  AND (p.data_source = 'counterpoint' OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL)
GROUP BY t.id
ORDER BY t.booked_at DESC
LIMIT 50;

\echo ''
\echo '6. Register close and drawer reconciliation'
SELECT
    id,
    register_lane,
    till_close_group_id,
    lifecycle_status,
    is_open,
    opening_float,
    expected_cash,
    actual_cash,
    cash_over_short,
    discrepancy,
    opened_at,
    closed_at,
    z_report_json IS NOT NULL AS has_z_report
FROM register_sessions
WHERE opened_at::date = :'audit_date'::date
   OR closed_at::date = :'audit_date'::date
ORDER BY opened_at;

SELECT
    rs.id AS register_session_id,
    pt.payment_method,
    COUNT(*) AS payment_rows,
    ROUND(COALESCE(SUM(pt.amount), 0), 2) AS payment_amount_sum
FROM register_sessions rs
JOIN payment_transactions pt ON pt.session_id = rs.id
WHERE rs.opened_at::date = :'audit_date'::date
   OR rs.closed_at::date = :'audit_date'::date
GROUP BY rs.id, pt.payment_method
ORDER BY rs.id, pt.payment_method;

SELECT id, sync_date, status, journal_entry_id, error_message, created_at, updated_at
FROM qbo_sync_logs
WHERE sync_date = :'audit_date'::date
ORDER BY created_at DESC;

\echo ''
\echo '7. Register inventory and fulfillment impact'
SELECT
    pv.id AS variant_id,
    pv.sku,
    pv.counterpoint_item_key,
    pv.stock_on_hand,
    pv.reserved_stock,
    pv.on_layaway,
    (COALESCE(pv.stock_on_hand, 0) - COALESCE(pv.reserved_stock, 0) - COALESCE(pv.on_layaway, 0)) AS available_stock
FROM product_variants pv
JOIN products p ON p.id = pv.product_id
WHERE p.data_source = 'counterpoint'
   OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL
ORDER BY available_stock ASC, pv.sku
LIMIT 100;

SELECT
    it.tx_type,
    COUNT(*) AS movement_count,
    COALESCE(SUM(it.quantity_delta), 0) AS quantity_delta_sum
FROM inventory_transactions it
JOIN product_variants pv ON pv.id = it.variant_id
JOIN products p ON p.id = pv.product_id
WHERE it.created_at::date = :'audit_date'::date
  AND (p.data_source = 'counterpoint' OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL)
GROUP BY it.tx_type
ORDER BY it.tx_type;

\echo 'Expected zero rows: imported variants with negative available stock'
SELECT pv.id AS variant_id, pv.sku, pv.stock_on_hand, pv.reserved_stock, pv.on_layaway,
       (COALESCE(pv.stock_on_hand, 0) - COALESCE(pv.reserved_stock, 0) - COALESCE(pv.on_layaway, 0)) AS available_stock
FROM product_variants pv
JOIN products p ON p.id = pv.product_id
WHERE (p.data_source = 'counterpoint' OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL)
  AND (COALESCE(pv.stock_on_hand, 0) - COALESCE(pv.reserved_stock, 0) - COALESCE(pv.on_layaway, 0)) < 0
ORDER BY available_stock ASC, pv.sku;

\echo 'Expected zero rows: order-style imported lines decremented before fulfillment'
SELECT it.id, it.variant_id, it.tx_type, it.quantity_delta, it.created_at, tl.id AS transaction_line_id, tl.fulfillment
FROM inventory_transactions it
JOIN transaction_lines tl ON tl.id = it.reference_id
JOIN product_variants pv ON pv.id = it.variant_id
JOIN products p ON p.id = pv.product_id
WHERE it.reference_table = 'transaction_lines'
  AND tl.fulfillment::text IN ('special_order', 'custom', 'wedding_order', 'layaway')
  AND it.tx_type::text IN ('sale', 'fulfillment')
  AND it.quantity_delta < 0
  AND tl.fulfilled_at IS NULL
  AND (p.data_source = 'counterpoint' OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL)
ORDER BY it.created_at DESC;

\echo ''
\echo '8. QBO staging from real register activity'
SELECT
    id,
    sync_date,
    status,
    journal_entry_id,
    payload #>> '{totals,debits}' AS debits,
    payload #>> '{totals,credits}' AS credits,
    payload #>> '{totals,balanced}' AS balanced,
    payload -> 'warnings' AS warnings,
    error_message,
    created_at,
    updated_at
FROM qbo_sync_logs
WHERE sync_date = :'audit_date'::date
ORDER BY created_at DESC;

SELECT
    COUNT(*) AS counterpoint_import_transactions_on_audit_date,
    ROUND(COALESCE(SUM(total_price), 0), 2) AS counterpoint_import_total_price_sum
FROM transactions
WHERE COALESCE(booked_at, created_at)::date = :'audit_date'::date
  AND is_counterpoint_import = true;

SELECT
    COUNT(*) AS current_ros_transactions_on_audit_date,
    ROUND(COALESCE(SUM(total_price), 0), 2) AS current_ros_total_price_sum
FROM transactions
WHERE COALESCE(booked_at, created_at)::date = :'audit_date'::date
  AND is_counterpoint_import = false;

\echo ''
\echo '9. QBO sync safety and reconciliation'
SELECT
    COUNT(*) FILTER (WHERE status = 'pending') AS pending_rows,
    COUNT(*) FILTER (WHERE status = 'approved') AS approved_rows,
    COUNT(*) FILTER (WHERE status = 'syncing') AS syncing_rows,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_rows,
    COUNT(*) FILTER (WHERE status = 'synced') AS synced_rows,
    COUNT(*) FILTER (WHERE status = 'voided') AS voided_rows
FROM qbo_sync_logs
WHERE sync_date = :'audit_date'::date;

\echo 'Expected zero rows: duplicate pending/approved QBO staging rows for same day'
SELECT sync_date, status, COUNT(*) AS row_count
FROM qbo_sync_logs
WHERE status IN ('pending', 'approved')
GROUP BY sync_date, status
HAVING COUNT(*) > 1
ORDER BY sync_date DESC, status;

\echo 'Expected zero rows: stale syncing QBO rows'
SELECT id, sync_date, status, updated_at, error_message
FROM qbo_sync_logs
WHERE status = 'syncing'
  AND updated_at < now() - interval '30 minutes'
ORDER BY updated_at;

\echo 'Expected zero rows: duplicate QBO journal_entry_id values'
SELECT journal_entry_id, COUNT(*) AS row_count
FROM qbo_sync_logs
WHERE NULLIF(TRIM(journal_entry_id), '') IS NOT NULL
GROUP BY journal_entry_id
HAVING COUNT(*) > 1
ORDER BY row_count DESC, journal_entry_id;

\echo ''
\echo 'Final GO/CAUTION helper: expected zero rows before operational rehearsal sign-off'
WITH bridge_proof_gaps AS (
    WITH staging AS (
        SELECT entity, COALESCE(SUM(row_count), 0) AS staged_rows
        FROM counterpoint_staging_batch
        WHERE status IN ('pending', 'applying', 'applied')
        GROUP BY entity
    ),
    landed AS (
        SELECT 'customers'::text AS entity, COUNT(*)::bigint AS landed_rows FROM customers WHERE customer_created_source = 'counterpoint'
        UNION ALL SELECT 'staff', COUNT(*)::bigint FROM staff WHERE data_source = 'counterpoint'
        UNION ALL SELECT 'catalog', COUNT(*)::bigint FROM products WHERE data_source = 'counterpoint'
        UNION ALL SELECT 'inventory', COUNT(*)::bigint FROM product_variants WHERE NULLIF(TRIM(counterpoint_item_key), '') IS NOT NULL
        UNION ALL SELECT 'gift_cards', COUNT(*)::bigint FROM gift_cards
        UNION ALL SELECT 'store_credit_opening', COUNT(*)::bigint FROM store_credit_ledger WHERE reason = 'counterpoint_opening_balance'
        UNION ALL SELECT 'loyalty_hist', COUNT(*)::bigint FROM customers WHERE customer_created_source = 'counterpoint' AND COALESCE(loyalty_points, 0) <> 0
        UNION ALL SELECT 'tickets', COUNT(*)::bigint FROM transactions WHERE counterpoint_ticket_ref IS NOT NULL
        UNION ALL SELECT 'open_docs', COUNT(*)::bigint FROM transactions WHERE counterpoint_doc_ref IS NOT NULL
    )
    SELECT COUNT(*) AS gap_count
    FROM counterpoint_sync_runs r
    LEFT JOIN staging s ON s.entity = r.entity
    LEFT JOIN landed l ON l.entity = r.entity
    WHERE COALESCE(r.records_processed, 0) > 0
      AND COALESCE(s.staged_rows, 0) = 0
      AND COALESCE(l.landed_rows, 0) = 0
),
imported_item_sales AS (
    SELECT COUNT(DISTINCT t.id) AS sale_count
    FROM transactions t
    JOIN transaction_lines tl ON tl.transaction_id = t.id
    LEFT JOIN products p ON p.id = tl.product_id
    LEFT JOIN product_variants pv ON pv.id = tl.variant_id
    WHERE COALESCE(t.booked_at, t.created_at)::date = :'audit_date'::date
      AND t.is_counterpoint_import = false
      AND (p.data_source = 'counterpoint' OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL)
),
blockers AS (
    SELECT 'qbo_live_integration_active' AS blocker, 'QBO integration is active outside sandbox.' AS detail
    WHERE EXISTS (SELECT 1 FROM qbo_integration WHERE is_active AND NOT use_sandbox)
    UNION ALL
    SELECT 'bridge_rows_without_ros_proof', gap_count::text || ' bridge entity row(s) lack staging/apply/landed proof.'
    FROM bridge_proof_gaps
    WHERE gap_count > 0
    UNION ALL
    SELECT 'open_counterpoint_staging_batches', COUNT(*)::text || ' pending/applying batch(es) remain.'
    FROM counterpoint_staging_batch
    WHERE status IN ('pending', 'applying')
    HAVING COUNT(*) > 0
    UNION ALL
    SELECT 'failed_counterpoint_staging_batches', COUNT(*)::text || ' failed batch(es) remain.'
    FROM counterpoint_staging_batch
    WHERE status = 'failed'
    HAVING COUNT(*) > 0
    UNION ALL
    SELECT 'unresolved_counterpoint_sync_issues', COUNT(*)::text || ' unresolved sync issue(s) remain.'
    FROM counterpoint_sync_issue
    WHERE resolved = false
    HAVING COUNT(*) > 0
    UNION ALL
    SELECT 'no_imported_item_register_sale', 'No current ROS sale with Counterpoint-ingested item exists for audit_date.'
    FROM imported_item_sales
    WHERE sale_count = 0
    UNION ALL
    SELECT 'missing_qbo_staging_for_audit_date', 'No QBO staging row exists for audit_date.'
    WHERE NOT EXISTS (SELECT 1 FROM qbo_sync_logs WHERE sync_date = :'audit_date'::date)
    UNION ALL
    SELECT 'counterpoint_import_contaminates_audit_date', COUNT(*)::text || ' historical Counterpoint import transaction(s) share audit_date.'
    FROM transactions
    WHERE COALESCE(booked_at, created_at)::date = :'audit_date'::date
      AND is_counterpoint_import = true
    HAVING COUNT(*) > 0
    UNION ALL
    SELECT 'duplicate_pending_or_approved_qbo_staging', COUNT(*)::text || ' duplicate pending/approved QBO staging group(s).'
    FROM (
        SELECT sync_date, status
        FROM qbo_sync_logs
        WHERE status IN ('pending', 'approved')
        GROUP BY sync_date, status
        HAVING COUNT(*) > 1
    ) dupes
    HAVING COUNT(*) > 0
)
SELECT blocker, detail
FROM blockers
ORDER BY blocker;

ROLLBACK;

-- Read-only forensic verification for the July 21-22, 2026 Counterpoint
-- fulfillment-status incident. Run with psql --csv and a read-only session.
--
-- This deliberately starts from retained correction events, not current
-- Orders filters or inferred lifecycle state. transaction_activity_log rows
-- are mutable in the current production schema, so the hashed export is the
-- retained evidence artifact; this query never changes data.

WITH recovery_events AS (
    SELECT
        a.transaction_id,
        a.id AS recovery_audit_event_id,
        a.created_at AS corrected_at,
        a.metadata->>'repair_id' AS repair_id,
        a.metadata->>'prior_status' AS prior_status,
        NULLIF(a.metadata->>'prior_fulfilled_at', '')::timestamptz AS prior_fulfilled_at,
        a.metadata->>'new_status' AS corrected_status,
        COALESCE((a.metadata->>'financial_values_changed')::boolean, TRUE)
            AS recovery_claimed_financial_change
    FROM public.transaction_activity_log a
    WHERE a.metadata->>'repair_id' IN (
        'counterpoint-open-doc-status-2026-07-22',
        'counterpoint-open-doc-balance-status-2026-07-22'
    )
),
recovery AS (
    SELECT
        transaction_id,
        string_agg(recovery_audit_event_id::text, ';' ORDER BY corrected_at)
            AS recovery_audit_event_ids,
        string_agg(repair_id, ';' ORDER BY corrected_at) AS repair_ids,
        MIN(corrected_at) AS first_corrected_at,
        MAX(corrected_at) AS last_corrected_at,
        string_agg(prior_status, ';' ORDER BY corrected_at) AS prior_statuses,
        string_agg(
            COALESCE(prior_fulfilled_at::text, ''),
            ';' ORDER BY corrected_at
        ) AS prior_fulfilled_timestamps,
        (array_agg(corrected_status ORDER BY corrected_at DESC))[1] AS corrected_status,
        BOOL_OR(recovery_claimed_financial_change) AS recovery_claimed_financial_change,
        COUNT(*)::bigint AS correction_event_count
    FROM recovery_events
    GROUP BY transaction_id
),
line_rollup AS (
    SELECT
        r.transaction_id,
        COUNT(tl.id) FILTER (WHERE NOT COALESCE(tl.is_internal, FALSE))::bigint
            AS business_line_count,
        COUNT(tl.id) FILTER (
            WHERE NOT COALESCE(tl.is_internal, FALSE)
              AND NOT tl.is_fulfilled
        )::bigint AS open_line_count,
        COUNT(tl.id) FILTER (
            WHERE NOT COALESCE(tl.is_internal, FALSE)
              AND tl.is_fulfilled
        )::bigint AS fulfilled_line_count,
        COUNT(tl.id) FILTER (
            WHERE NOT COALESCE(tl.is_internal, FALSE)
              AND NOT tl.is_fulfilled
              AND tl.fulfilled_at IS NOT NULL
        )::bigint AS open_lines_with_fulfilled_timestamp
    FROM recovery r
    LEFT JOIN public.transaction_lines tl ON tl.transaction_id = r.transaction_id
    GROUP BY r.transaction_id
),
payment_rollup AS (
    SELECT
        r.transaction_id,
        COUNT(pa.id)::bigint AS allocation_count,
        COALESCE(SUM(pa.amount_allocated), 0)::numeric(14,2) AS allocated_tender_total,
        COUNT(pa.id) FILTER (
            WHERE pt.created_at >= '2026-07-21T20:49:04Z'
              AND pt.created_at <  '2026-07-21T20:49:35Z'
        )::bigint AS bad_apply_window_currently_linked_payment_transactions,
        COUNT(pa.id) FILTER (
            WHERE pt.created_at >= '2026-07-22T21:20:14Z'
              AND pt.created_at <  '2026-07-22T21:21:36Z'
        )::bigint AS recovery_window_currently_linked_payment_transactions
    FROM recovery r
    LEFT JOIN public.payment_allocations pa ON pa.target_transaction_id = r.transaction_id
    LEFT JOIN public.payment_transactions pt ON pt.id = pa.transaction_id
    GROUP BY r.transaction_id
),
inventory_rollup AS (
    SELECT
        r.transaction_id,
        COUNT(it.id)::bigint AS inventory_movement_count,
        COUNT(it.id) FILTER (
            WHERE it.created_at >= '2026-07-21T20:49:04Z'
              AND it.created_at <  '2026-07-21T20:49:35Z'
        )::bigint AS bad_apply_window_inventory_rows,
        COUNT(it.id) FILTER (
            WHERE it.created_at >= '2026-07-22T21:20:14Z'
              AND it.created_at <  '2026-07-22T21:21:36Z'
        )::bigint AS recovery_window_inventory_rows
    FROM recovery r
    LEFT JOIN public.inventory_transactions it
      ON it.reference_table = 'transactions'
     AND it.reference_id = r.transaction_id
    GROUP BY r.transaction_id
),
commission_rollup AS (
    SELECT
        r.transaction_id,
        COUNT(ce.id)::bigint AS commission_event_count,
        COUNT(ce.id) FILTER (
            WHERE ce.created_at >= '2026-07-21T20:49:04Z'
              AND ce.created_at <  '2026-07-21T20:49:35Z'
        )::bigint AS bad_apply_window_commission_rows,
        COUNT(ce.id) FILTER (
            WHERE ce.created_at >= '2026-07-22T21:20:14Z'
              AND ce.created_at <  '2026-07-22T21:21:36Z'
        )::bigint AS recovery_window_commission_rows,
        COUNT(ce.id) FILTER (
            WHERE ce.event_type IN ('sale_commission', 'spiff', 'combo_incentive')
              AND ce.transaction_line_id IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM public.transaction_lines open_line
                  WHERE open_line.id = ce.transaction_line_id
                    AND NOT open_line.is_fulfilled
              )
        )::bigint AS commission_events_on_current_open_lines
    FROM recovery r
    LEFT JOIN public.commission_events ce ON ce.transaction_id = r.transaction_id
    GROUP BY r.transaction_id
),
loyalty_rollup AS (
    SELECT
        r.transaction_id,
        (SELECT COUNT(*) FROM public.transaction_loyalty_accrual la
         WHERE la.transaction_id = r.transaction_id)::bigint AS accrual_count,
        (SELECT COUNT(*) FROM public.loyalty_point_ledger lp
         WHERE lp.transaction_id = r.transaction_id)::bigint AS loyalty_ledger_count,
        (
            (SELECT COUNT(*) FROM public.transaction_loyalty_accrual la
             WHERE la.transaction_id = r.transaction_id
               AND la.created_at >= '2026-07-21T20:49:04Z'
               AND la.created_at <  '2026-07-21T20:49:35Z')
            +
            (SELECT COUNT(*) FROM public.loyalty_point_ledger lp
             WHERE lp.transaction_id = r.transaction_id
               AND lp.created_at >= '2026-07-21T20:49:04Z'
               AND lp.created_at <  '2026-07-21T20:49:35Z')
        )::bigint AS bad_apply_window_loyalty_rows,
        (
            (SELECT COUNT(*) FROM public.transaction_loyalty_accrual la
             WHERE la.transaction_id = r.transaction_id
               AND la.created_at >= '2026-07-22T21:20:14Z'
               AND la.created_at <  '2026-07-22T21:21:36Z')
            +
            (SELECT COUNT(*) FROM public.loyalty_point_ledger lp
             WHERE lp.transaction_id = r.transaction_id
               AND lp.created_at >= '2026-07-22T21:20:14Z'
               AND lp.created_at <  '2026-07-22T21:21:36Z')
        )::bigint AS recovery_window_loyalty_rows
    FROM recovery r
),
audit_rollup AS (
    SELECT
        r.transaction_id,
        COUNT(a.id) FILTER (
            WHERE a.metadata->>'repair_id' IN (
                'counterpoint-open-doc-status-2026-07-22',
                'counterpoint-open-doc-balance-status-2026-07-22'
            )
        )::bigint AS recovery_audit_count,
        COUNT(a.id) FILTER (
            WHERE a.event_kind IN ('pickup', 'shipment', 'ship')
              AND a.created_at > r.last_corrected_at
        )::bigint AS later_fulfillment_audit_count
    FROM recovery r
    LEFT JOIN public.transaction_activity_log a ON a.transaction_id = r.transaction_id
    GROUP BY r.transaction_id
),
outbox_rollup AS (
    SELECT
        r.transaction_id,
        (SELECT COUNT(*) FROM public.qbo_sync_outbox q
         WHERE q.transaction_id = r.transaction_id)::bigint AS legacy_qbo_outbox_count,
        (SELECT COUNT(*) FROM public.qbo_sync_outbox q
         WHERE q.transaction_id = r.transaction_id
           AND q.created_at >= '2026-07-21T20:49:04Z'
           AND q.created_at <  '2026-07-21T20:49:35Z')::bigint
            AS bad_apply_window_qbo_outbox_jobs,
        (SELECT COUNT(*) FROM public.qbo_sync_outbox q
         WHERE q.transaction_id = r.transaction_id
           AND q.created_at >= '2026-07-22T21:20:14Z'
           AND q.created_at <  '2026-07-22T21:21:36Z')::bigint
            AS recovery_window_qbo_outbox_jobs,
        (SELECT COUNT(*) FROM public.operational_outbox o
         WHERE o.payload->>'transaction_id' = r.transaction_id::text
           AND o.created_at >= '2026-07-21T20:49:04Z'
           AND o.created_at <  '2026-07-21T20:49:35Z')::bigint
            AS bad_apply_window_operational_jobs,
        (SELECT COUNT(*) FROM public.operational_outbox o
         WHERE o.payload->>'transaction_id' = r.transaction_id::text
           AND o.created_at >= '2026-07-22T21:20:14Z'
           AND o.created_at <  '2026-07-22T21:21:36Z')::bigint
            AS recovery_window_operational_jobs
    FROM recovery r
),
verified AS (
    SELECT
        r.*,
        regexp_replace(
            COALESCE(NULLIF(TRIM(t.display_id), ''), t.counterpoint_doc_ref, t.id::text),
            E'[\\r\\n]+',
            ' ',
            'g'
        ) AS display_id,
        t.status::text AS current_status,
        t.fulfilled_at AS current_fulfilled_at,
        t.total_price,
        t.amount_paid,
        t.balance_due,
        reporting.order_recognition_at(
            t.id,
            t.fulfillment_method::text,
            t.status::text,
            t.fulfilled_at
        ) AS current_header_recognition_at,
        lines.business_line_count,
        lines.open_line_count,
        lines.fulfilled_line_count,
        lines.open_lines_with_fulfilled_timestamp,
        payments.allocation_count,
        payments.allocated_tender_total,
        (payments.allocated_tender_total - t.amount_paid)::numeric(14,2)
            AS stored_paid_allocation_delta,
        payments.bad_apply_window_currently_linked_payment_transactions,
        payments.recovery_window_currently_linked_payment_transactions,
        inventory.inventory_movement_count,
        inventory.bad_apply_window_inventory_rows,
        inventory.recovery_window_inventory_rows,
        commissions.commission_event_count,
        commissions.bad_apply_window_commission_rows,
        commissions.recovery_window_commission_rows,
        commissions.commission_events_on_current_open_lines,
        loyalty.accrual_count,
        loyalty.loyalty_ledger_count,
        loyalty.bad_apply_window_loyalty_rows,
        loyalty.recovery_window_loyalty_rows,
        audits.recovery_audit_count,
        audits.later_fulfillment_audit_count,
        outbox.legacy_qbo_outbox_count,
        outbox.bad_apply_window_qbo_outbox_jobs,
        outbox.recovery_window_qbo_outbox_jobs,
        outbox.bad_apply_window_operational_jobs,
        outbox.recovery_window_operational_jobs
    FROM recovery r
    INNER JOIN public.transactions t ON t.id = r.transaction_id
    INNER JOIN line_rollup lines ON lines.transaction_id = r.transaction_id
    INNER JOIN payment_rollup payments ON payments.transaction_id = r.transaction_id
    INNER JOIN inventory_rollup inventory ON inventory.transaction_id = r.transaction_id
    INNER JOIN commission_rollup commissions ON commissions.transaction_id = r.transaction_id
    INNER JOIN loyalty_rollup loyalty ON loyalty.transaction_id = r.transaction_id
    INNER JOIN audit_rollup audits ON audits.transaction_id = r.transaction_id
    INNER JOIN outbox_rollup outbox ON outbox.transaction_id = r.transaction_id
)
SELECT
    transaction_id,
    display_id,
    repair_ids,
    recovery_audit_event_ids,
    first_corrected_at,
    last_corrected_at,
    correction_event_count,
    prior_statuses,
    prior_fulfilled_timestamps,
    corrected_status,
    recovery_claimed_financial_change,
    current_status,
    current_fulfilled_at,
    current_header_recognition_at,
    business_line_count,
    open_line_count,
    fulfilled_line_count,
    open_lines_with_fulfilled_timestamp,
    total_price,
    amount_paid,
    balance_due,
    allocation_count,
    allocated_tender_total,
    stored_paid_allocation_delta,
    bad_apply_window_currently_linked_payment_transactions,
    recovery_window_currently_linked_payment_transactions,
    'payment_allocations_has_no_created_at; historical allocation creation timing is not provable'::text
        AS payment_allocation_timing_traceability,
    inventory_movement_count,
    bad_apply_window_inventory_rows,
    recovery_window_inventory_rows,
    'inventory rows link to Transaction Record and variant, not to an individual line or pickup event; pre-movement balances are not retained'::text
        AS inventory_traceability,
    commission_event_count,
    bad_apply_window_commission_rows,
    recovery_window_commission_rows,
    commission_events_on_current_open_lines,
    accrual_count,
    loyalty_ledger_count,
    bad_apply_window_loyalty_rows,
    recovery_window_loyalty_rows,
    recovery_audit_count,
    later_fulfillment_audit_count,
    legacy_qbo_outbox_count,
    bad_apply_window_qbo_outbox_jobs,
    recovery_window_qbo_outbox_jobs,
    bad_apply_window_operational_jobs,
    recovery_window_operational_jobs,
    'not_provable_per_transaction_from_aggregate_qbo_schema'::text AS qbo_traceability,
    CASE
        WHEN repair_ids LIKE '%counterpoint-open-doc-balance-status-2026-07-22%'
          AND current_status = 'open'
          AND current_fulfilled_at IS NULL
          AND current_header_recognition_at IS NULL
          AND open_line_count = 0
          AND fulfilled_line_count > 0
          AND inventory_movement_count > 0
          AND accrual_count > 0
          AND loyalty_ledger_count > 0
          AND btrim(prior_fulfilled_timestamps, ';') <> ''
            THEN 'failed_recovery_removed_fulfilled_recognition'
        WHEN recovery_audit_count <> correction_event_count
          OR recovery_claimed_financial_change
          OR bad_apply_window_currently_linked_payment_transactions <> 0
          OR recovery_window_currently_linked_payment_transactions <> 0
          OR bad_apply_window_inventory_rows <> 0
          OR recovery_window_inventory_rows <> 0
          OR bad_apply_window_commission_rows <> 0
          OR recovery_window_commission_rows <> 0
          OR bad_apply_window_loyalty_rows <> 0
          OR recovery_window_loyalty_rows <> 0
          OR bad_apply_window_qbo_outbox_jobs <> 0
          OR recovery_window_qbo_outbox_jobs <> 0
          OR bad_apply_window_operational_jobs <> 0
          OR recovery_window_operational_jobs <> 0
            THEN 'failed_other_ledger_change'
        WHEN correction_event_count <> 1
          OR open_lines_with_fulfilled_timestamp <> 0
          OR commission_events_on_current_open_lines <> 0
          OR (current_status = 'fulfilled' AND later_fulfillment_audit_count = 0)
          OR stored_paid_allocation_delta <> 0
            THEN 'review_required_current_exception'
        ELSE 'review_required_traceability_gaps'
    END AS verification_status
FROM verified
ORDER BY display_id, transaction_id;

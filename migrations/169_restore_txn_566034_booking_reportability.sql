-- Restore the reviewed July 28 staff amendment on TXN-566034 to Booked
-- Daily/Z reporting. Historical Counterpoint repair events remain excluded.
--
-- Scope is fail-closed to the exact Transaction, SKU, line price, event date,
-- and signed subtotal deltas already verified in the Transaction Record.

WITH reviewed_events AS (
    SELECT
        event.id,
        event.event_kind
    FROM public.transaction_line_booking_events event
    INNER JOIN public.transactions t
        ON t.id = event.transaction_id
    INNER JOIN public.transaction_lines line
        ON line.id = event.transaction_line_id
       AND line.transaction_id = t.id
    INNER JOIN public.product_variants variant
        ON variant.id = line.variant_id
    WHERE t.display_id = 'TXN-566034'
      AND t.status = 'open'
      AND variant.sku = 'B-1417953'
      AND line.quantity = 1
      AND line.unit_price = 300.00
      AND (
          event.booked_at
          AT TIME ZONE reporting.effective_store_timezone()
      )::date = DATE '2026-07-28'
      AND (
          (
              event.event_kind IN ('initial_booking', 'line_added')
              AND event.subtotal_delta = 375.00
          )
          OR (
              event.event_kind = 'line_amendment'
              AND event.subtotal_delta = -75.00
              AND event.metadata->>'repair_migration'
                  = '168_repair_txn_566034_amended_line_price.sql'
          )
      )
)
UPDATE public.transaction_line_booking_events event
SET
    event_kind = CASE
        WHEN reviewed.event_kind = 'initial_booking' THEN 'line_added'
        ELSE event.event_kind
    END,
    is_internal = FALSE,
    line_kind = NULL,
    metadata = (
        COALESCE(event.metadata, '{}'::jsonb)
        - 'reporting_excluded'
        - 'reporting_exclusion_reason'
    ) || jsonb_build_object(
        'source_workflow', 'staff_order_edit',
        'reporting_restored_by',
            '169_restore_txn_566034_booking_reportability.sql'
    )
FROM reviewed_events reviewed
WHERE event.id = reviewed.id;

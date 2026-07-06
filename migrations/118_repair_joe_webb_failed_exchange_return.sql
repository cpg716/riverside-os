-- Repair one stale return marker created while the register exchange flow was failing.
-- Scope is intentionally narrow: TXN-621978, Mantoni Classic Fit DrShirt only.
-- This restores the line as returnable so the exchange can be completed through
-- the fixed settlement path instead of leaving a half-recorded return behind.

DROP TABLE IF EXISTS pg_temp.ros_118_joe_webb_failed_exchange_return;

CREATE TEMP TABLE ros_118_joe_webb_failed_exchange_return AS
SELECT
    trl.id AS return_line_id,
    trl.transaction_id,
    trl.transaction_line_id,
    trl.quantity_returned,
    trl.restocked,
    tl.variant_id,
    tl.product_id,
    t.customer_id
FROM public.transaction_return_lines trl
INNER JOIN public.transactions t ON t.id = trl.transaction_id
INNER JOIN public.transaction_lines tl ON tl.id = trl.transaction_line_id
LEFT JOIN public.products p ON p.id = tl.product_id
LEFT JOIN public.product_variants pv ON pv.id = tl.variant_id
WHERE (
      t.display_id = 'TXN-621978'
      OR t.short_id = 'TXN-621978'
      OR t.short_id = '621978'
      OR COALESCE(t.counterpoint_doc_ref, '') = '621978'
      OR COALESCE(t.counterpoint_ticket_ref, '') ILIKE '%|621978|%'
      OR COALESCE(t.counterpoint_ticket_ref, '') ILIKE '%101321480780%'
  )
  AND LOWER(COALESCE(p.name, '')) = LOWER('Mantoni Classic Fit DrShirt')
  AND (
      NULLIF(TRIM(COALESCE(pv.sku, '')), '') IS NULL
      OR pv.sku ILIKE 'B-1471081%'
      OR pv.sku ILIKE '%M20001-1%'
  );

INSERT INTO public.transaction_activity_log (
    transaction_id,
    customer_id,
    event_kind,
    summary,
    metadata
)
SELECT DISTINCT
    target.transaction_id,
    target.customer_id,
    'return_repair',
    'Removed stale failed exchange return marker for Mantoni Classic Fit DrShirt.',
    jsonb_build_object(
        'repair_migration', '118_repair_joe_webb_failed_exchange_return.sql',
        'transaction_display', 'TXN-621978',
        'product_name', 'Mantoni Classic Fit DrShirt',
        'return_line_ids', (
            SELECT jsonb_agg(return_line_id ORDER BY return_line_id)
            FROM ros_118_joe_webb_failed_exchange_return
        ),
        'reason', 'Prior register exchange attempt recorded the return before the exchange could be completed.'
    )
FROM ros_118_joe_webb_failed_exchange_return target
WHERE NOT EXISTS (
    SELECT 1
    FROM public.transaction_activity_log existing
    WHERE existing.transaction_id = target.transaction_id
      AND existing.event_kind = 'return_repair'
      AND existing.metadata->>'repair_migration' = '118_repair_joe_webb_failed_exchange_return.sql'
);

INSERT INTO public.inventory_transactions (
    variant_id,
    tx_type,
    quantity_delta,
    reference_table,
    reference_id,
    notes
)
SELECT
    reversal.variant_id,
    'adjustment'::public.inventory_tx_type,
    -reversal.quantity_returned,
    'transaction_return_repair',
    reversal.transaction_line_id,
    'Migration 118: reverse stale failed exchange return stock for TXN-621978 Mantoni Classic Fit DrShirt'
FROM (
    SELECT
        variant_id,
        transaction_line_id,
        SUM(quantity_returned)::int AS quantity_returned
    FROM ros_118_joe_webb_failed_exchange_return
    WHERE restocked = TRUE
      AND variant_id IS NOT NULL
    GROUP BY variant_id, transaction_line_id
) reversal
WHERE reversal.quantity_returned <> 0
  AND NOT EXISTS (
      SELECT 1
      FROM public.inventory_transactions existing
      WHERE existing.reference_table = 'transaction_return_repair'
        AND existing.reference_id = reversal.transaction_line_id
        AND existing.notes = 'Migration 118: reverse stale failed exchange return stock for TXN-621978 Mantoni Classic Fit DrShirt'
  );

UPDATE public.product_variants pv
SET stock_on_hand = COALESCE(pv.stock_on_hand, 0) - reversal.quantity_returned
FROM (
    SELECT
        variant_id,
        SUM(quantity_returned)::int AS quantity_returned
    FROM ros_118_joe_webb_failed_exchange_return
    WHERE restocked = TRUE
      AND variant_id IS NOT NULL
    GROUP BY variant_id
) reversal
WHERE pv.id = reversal.variant_id
  AND reversal.quantity_returned <> 0;

INSERT INTO public.commission_events (
    staff_id,
    transaction_id,
    transaction_line_id,
    source_event_id,
    event_type,
    event_at,
    reporting_date,
    commissionable_amount,
    base_rate_used,
    base_commission_amount,
    incentive_amount,
    adjustment_amount,
    total_commission_amount,
    snapshot_json,
    note,
    created_by_staff_id
)
SELECT
    ce.staff_id,
    ce.transaction_id,
    ce.transaction_line_id,
    ce.source_event_id,
    'manual_adjustment',
    now(),
    (now() AT TIME ZONE 'UTC')::date,
    0,
    0,
    0,
    0,
    -ce.adjustment_amount,
    -ce.total_commission_amount,
    ce.snapshot_json || jsonb_build_object(
        'repair_migration', '118_repair_joe_webb_failed_exchange_return.sql',
        'reason', 'Reverse stale failed exchange return commission adjustment'
    ),
    'Reverse stale failed exchange return commission adjustment',
    ce.created_by_staff_id
FROM public.commission_events ce
INNER JOIN ros_118_joe_webb_failed_exchange_return target
    ON target.return_line_id = ce.source_event_id
WHERE ce.event_type = 'return_adjustment'
  AND NOT EXISTS (
      SELECT 1
      FROM public.commission_events existing
      WHERE existing.source_event_id = ce.source_event_id
        AND existing.event_type = 'manual_adjustment'
        AND existing.snapshot_json->>'repair_migration' = '118_repair_joe_webb_failed_exchange_return.sql'
  );

DELETE FROM public.transaction_return_lines trl
USING ros_118_joe_webb_failed_exchange_return target
WHERE trl.id = target.return_line_id;

WITH recalculated AS (
    SELECT
        t.id AS transaction_id,
        COALESCE(SUM(
            (tl.unit_price + COALESCE(tl.state_tax, 0) + COALESCE(tl.local_tax, 0))::numeric
            * GREATEST(tl.quantity - COALESCE(returned.returned_qty, 0), 0)::numeric
        ), 0::numeric) + COALESCE(t.shipping_amount_usd, 0)::numeric AS total_price,
        COALESCE(t.amount_paid, 0)::numeric AS amount_paid,
        COALESCE(t.rounding_adjustment, 0)::numeric AS rounding_adjustment
    FROM public.transactions t
    LEFT JOIN public.transaction_lines tl ON tl.transaction_id = t.id
    LEFT JOIN (
        SELECT transaction_line_id, SUM(quantity_returned)::int AS returned_qty
        FROM public.transaction_return_lines
        GROUP BY transaction_line_id
    ) returned ON returned.transaction_line_id = tl.id
    WHERE t.id IN (
        SELECT DISTINCT transaction_id
        FROM ros_118_joe_webb_failed_exchange_return
    )
    GROUP BY t.id, t.amount_paid, t.rounding_adjustment, t.shipping_amount_usd
)
UPDATE public.transactions t
SET total_price = ROUND(recalculated.total_price, 2),
    balance_due = ROUND(recalculated.total_price + recalculated.rounding_adjustment - recalculated.amount_paid, 2)
FROM recalculated
WHERE t.id = recalculated.transaction_id;

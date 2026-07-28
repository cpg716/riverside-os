-- Repair the Gruppo Bravo Tux added to TXN-566034 on 2026-07-28 after the
-- staff-entered $300.00 price did not persist and the line remained at $375.00.
-- Scope is deliberately fail-closed to the reviewed transaction, SKU, line
-- booking date, and exact saved financial state.

DROP TABLE IF EXISTS pg_temp.ros_168_txn_566034_price_repair;

CREATE TEMP TABLE ros_168_txn_566034_price_repair AS
SELECT
    t.id AS transaction_id,
    t.customer_id,
    line.id AS transaction_line_id,
    line.unit_price AS unit_price_before,
    line.state_tax AS state_tax_before,
    line.local_tax AS local_tax_before,
    t.total_price AS total_before,
    t.balance_due AS balance_before,
    COALESCE(
        (
            SELECT activity.created_at
            FROM public.transaction_activity_log activity
            WHERE activity.transaction_id = t.id
              AND activity.event_kind = 'item_updated'
              AND activity.created_at::date = DATE '2026-07-28'
            ORDER BY activity.created_at DESC
            LIMIT 1
        ),
        line.booked_at
    ) AS amendment_booked_at,
    CURRENT_TIMESTAMP AS repair_started_at
FROM public.transactions t
INNER JOIN public.transaction_lines line ON line.transaction_id = t.id
INNER JOIN public.product_variants variant ON variant.id = line.variant_id
WHERE t.display_id = 'TXN-566034'
  AND t.status = 'open'
  AND variant.sku = 'B-1417953'
  AND line.quantity = 1
  AND line.unit_price = 375.00
  AND (line.booked_at AT TIME ZONE reporting.effective_store_timezone())::date
      = DATE '2026-07-28'
  AND COALESCE(line.is_internal, false) = false
  AND t.total_price = 1469.21
  AND t.amount_paid = 412.95
  AND t.balance_due = 1056.26
  AND NOT EXISTS (
      SELECT 1
      FROM public.transaction_return_lines returned
      WHERE returned.transaction_line_id = line.id
  )
  AND NOT EXISTS (
      SELECT 1
      FROM public.transaction_activity_log existing
      WHERE existing.transaction_id = t.id
        AND existing.event_kind = 'price_repair'
        AND existing.metadata->>'repair_migration'
            = '168_repair_txn_566034_amended_line_price.sql'
  );

UPDATE public.transaction_lines line
SET
    unit_price = 300.00,
    state_tax = ROUND(COALESCE(line.state_tax, 0) * 300.00 / 375.00, 2),
    local_tax = ROUND(COALESCE(line.local_tax, 0) * 300.00 / 375.00, 2)
FROM ros_168_txn_566034_price_repair repair
WHERE line.id = repair.transaction_line_id;

-- The trigger records the financial delta. Preserve the staff action time as
-- its booked date so this correction belongs to the same Daily/Z reporting day
-- as the item addition, regardless of when the release is installed.
UPDATE public.transaction_line_booking_events event
SET
    booked_at = repair.amendment_booked_at,
    metadata = event.metadata || jsonb_build_object(
        'repair_migration', '168_repair_txn_566034_amended_line_price.sql',
        'staff_entered_price_recovered', true
    )
FROM ros_168_txn_566034_price_repair repair
WHERE event.transaction_id = repair.transaction_id
  AND event.transaction_line_id = repair.transaction_line_id
  AND event.event_kind = 'line_amendment'
  AND event.created_at >= repair.repair_started_at;

WITH recalculated AS (
    SELECT
        t.id AS transaction_id,
        (
            COALESCE(SUM(
                (
                    line.unit_price
                    + COALESCE(line.state_tax, 0)
                    + COALESCE(line.local_tax, 0)
                )::numeric
                * GREATEST(
                    line.quantity - COALESCE(returned.returned_qty, 0),
                    0
                )::numeric
            ), 0::numeric)
            + COALESCE(t.shipping_amount_usd, 0)::numeric
        )::numeric(14,2) AS total_price
    FROM public.transactions t
    INNER JOIN ros_168_txn_566034_price_repair repair
        ON repair.transaction_id = t.id
    LEFT JOIN public.transaction_lines line ON line.transaction_id = t.id
    LEFT JOIN (
        SELECT transaction_line_id, SUM(quantity_returned)::int AS returned_qty
        FROM public.transaction_return_lines
        GROUP BY transaction_line_id
    ) returned ON returned.transaction_line_id = line.id
    GROUP BY t.id, t.shipping_amount_usd
)
UPDATE public.transactions t
SET
    total_price = recalculated.total_price,
    balance_due = (
        recalculated.total_price
        + COALESCE(t.rounding_adjustment, 0)
        - COALESCE(t.amount_paid, 0)
    )::numeric(14,2)
FROM recalculated
WHERE t.id = recalculated.transaction_id;

INSERT INTO public.transaction_activity_log (
    transaction_id,
    customer_id,
    event_kind,
    summary,
    metadata,
    created_at
)
SELECT
    repair.transaction_id,
    repair.customer_id,
    'price_repair',
    'Recovered staff-entered price for Gruppo Bravo Tux (B-1417953): $375.00 → $300.00',
    jsonb_build_object(
        'repair_migration', '168_repair_txn_566034_amended_line_price.sql',
        'transaction_line_id', repair.transaction_line_id,
        'product_name', 'Gruppo Bravo Tux (40901)',
        'sku', 'B-1417953',
        'unit_price_before', repair.unit_price_before,
        'unit_price_after', '300.00',
        'state_tax_before', repair.state_tax_before,
        'state_tax_after', line.state_tax,
        'local_tax_before', repair.local_tax_before,
        'local_tax_after', line.local_tax,
        'total_before', repair.total_before,
        'total_after', t.total_price,
        'balance_before', repair.balance_before,
        'balance_after', t.balance_due,
        'payments_and_allocations_preserved', true
    ),
    repair.amendment_booked_at
FROM ros_168_txn_566034_price_repair repair
INNER JOIN public.transaction_lines line ON line.id = repair.transaction_line_id
INNER JOIN public.transactions t ON t.id = repair.transaction_id;

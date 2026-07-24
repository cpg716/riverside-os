-- Repair TXN-624473 after an open-order price amendment retained the vest's
-- tax from its prior catalog price. Scope is deliberately fail-closed to the
-- two reviewed replacement SKUs and the exact saved financial state.
--
-- This changes only line tax plus the derived Transaction Record total/balance.
-- Payments, allocations, fulfillment, inventory, and line prices are preserved.

DROP TABLE IF EXISTS pg_temp.ros_160_txn_624473_tax_repair;

CREATE TEMP TABLE ros_160_txn_624473_tax_repair AS
SELECT
    t.id AS transaction_id,
    t.customer_id,
    vest.id AS vest_line_id,
    vest.state_tax AS vest_state_tax_before,
    vest.local_tax AS vest_local_tax_before,
    tux.id AS tux_line_id,
    tux.state_tax AS tux_state_tax_before,
    tux.local_tax AS tux_local_tax_before,
    t.total_price AS total_before,
    t.balance_due AS balance_before
FROM public.transactions t
INNER JOIN public.transaction_lines vest ON vest.transaction_id = t.id
INNER JOIN public.product_variants vest_variant ON vest_variant.id = vest.variant_id
INNER JOIN public.transaction_lines tux ON tux.transaction_id = t.id
INNER JOIN public.product_variants tux_variant ON tux_variant.id = tux.variant_id
WHERE t.display_id = 'TXN-624473'
  AND t.status = 'open'
  AND COALESCE(t.is_tax_exempt, false) = false
  AND t.total_price = 346.37
  AND vest_variant.sku = 'B-1566214'
  AND vest.quantity = 1
  AND vest.unit_price = 50.00
  AND COALESCE(vest.is_internal, false) = false
  AND tux_variant.sku = 'B-1417946'
  AND tux.quantity = 1
  AND tux.unit_price = 260.00
  AND COALESCE(tux.is_internal, false) = false
  AND (
      COALESCE(vest.state_tax, 0)
      + COALESCE(vest.local_tax, 0)
      + COALESCE(tux.state_tax, 0)
      + COALESCE(tux.local_tax, 0)
  ) = 36.37
  AND NOT EXISTS (
      SELECT 1
      FROM public.transaction_return_lines returned
      WHERE returned.transaction_line_id IN (vest.id, tux.id)
  )
  AND (
      SELECT COUNT(*)
      FROM public.transaction_lines line_count
      WHERE line_count.transaction_id = t.id
        AND COALESCE(line_count.is_internal, false) = false
  ) = 2;

UPDATE public.transaction_lines line
SET
    state_tax = corrected.state_tax,
    local_tax = corrected.local_tax
FROM (
    SELECT
        repair.vest_line_id AS transaction_line_id,
        0.00::numeric AS state_tax,
        2.38::numeric AS local_tax
    FROM ros_160_txn_624473_tax_repair repair

    UNION ALL

    SELECT
        repair.tux_line_id AS transaction_line_id,
        10.40::numeric AS state_tax,
        12.35::numeric AS local_tax
    FROM ros_160_txn_624473_tax_repair repair
) corrected
WHERE line.id = corrected.transaction_line_id;

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
                * GREATEST(line.quantity - COALESCE(returned.returned_qty, 0), 0)::numeric
            ), 0::numeric)
            + COALESCE(t.shipping_amount_usd, 0)::numeric
        )::numeric(14,2) AS total_price
    FROM public.transactions t
    INNER JOIN ros_160_txn_624473_tax_repair repair ON repair.transaction_id = t.id
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
    metadata
)
SELECT
    repair.transaction_id,
    repair.customer_id,
    'tax_repair',
    'Corrected tax after an open-order line price amendment.',
    jsonb_build_object(
        'repair_migration', '160_repair_txn_624473_amended_line_tax.sql',
        'transaction_display_id', 'TXN-624473',
        'reason', 'Vest price changed to $50.00 while its prior catalog-price tax remained stored.',
        'vest', jsonb_build_object(
            'sku', 'B-1566214',
            'unit_price', '50.00',
            'state_tax_before', repair.vest_state_tax_before,
            'local_tax_before', repair.vest_local_tax_before,
            'state_tax_after', '0.00',
            'local_tax_after', '2.38'
        ),
        'tux', jsonb_build_object(
            'sku', 'B-1417946',
            'unit_price', '260.00',
            'state_tax_before', repair.tux_state_tax_before,
            'local_tax_before', repair.tux_local_tax_before,
            'state_tax_after', '10.40',
            'local_tax_after', '12.35'
        ),
        'total_before', repair.total_before,
        'total_after', t.total_price,
        'balance_before', repair.balance_before,
        'balance_after', t.balance_due,
        'payments_and_allocations_preserved', true
    )
FROM ros_160_txn_624473_tax_repair repair
INNER JOIN public.transactions t ON t.id = repair.transaction_id
WHERE NOT EXISTS (
    SELECT 1
    FROM public.transaction_activity_log existing
    WHERE existing.transaction_id = repair.transaction_id
      AND existing.event_kind = 'tax_repair'
      AND existing.metadata->>'repair_migration'
          = '160_repair_txn_624473_amended_line_tax.sql'
);

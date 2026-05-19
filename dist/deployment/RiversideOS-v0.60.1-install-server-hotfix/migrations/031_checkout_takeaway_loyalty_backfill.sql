-- Repair fully-paid takeaway checkouts that were left open and therefore skipped
-- loyalty accrual. Future checkout inserts now write the transaction status
-- directly; this migration only backfills existing affected rows.

DROP TABLE IF EXISTS pg_temp.checkout_takeaway_status_backfill;

CREATE TEMP TABLE checkout_takeaway_status_backfill AS
WITH fulfilled_takeaway_transactions AS (
  SELECT
    t.id,
    COALESCE(t.fulfilled_at, MAX(tl.fulfilled_at), t.booked_at) AS fulfilled_at
  FROM transactions t
  JOIN transaction_lines tl ON tl.transaction_id = t.id
  WHERE t.status = 'open'::order_status
    AND t.balance_due = 0
    AND COALESCE(t.shipping_amount_usd, 0) = 0
    AND (t.checkout_client_id IS NOT NULL OR t.register_session_id IS NOT NULL)
  GROUP BY t.id, t.fulfilled_at, t.booked_at
  HAVING COUNT(*) > 0
     AND COUNT(*) FILTER (
       WHERE tl.fulfillment <> 'takeaway'::fulfillment_type
          OR tl.is_fulfilled = FALSE
     ) = 0
)
SELECT id, fulfilled_at
FROM fulfilled_takeaway_transactions;

UPDATE transactions t
SET status = 'fulfilled'::order_status,
    fulfilled_at = checkout_takeaway_status_backfill.fulfilled_at
FROM checkout_takeaway_status_backfill
WHERE t.id = checkout_takeaway_status_backfill.id;

DROP TABLE IF EXISTS pg_temp.checkout_takeaway_loyalty_backfill;

CREATE TEMP TABLE checkout_takeaway_loyalty_backfill AS
WITH returned AS (
  SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
  FROM transaction_return_lines
  GROUP BY transaction_line_id
),
eligible_subtotals AS (
  SELECT
    tl.transaction_id,
    COALESCE(
      SUM(
        tl.unit_price
        * GREATEST(tl.quantity - COALESCE(returned.returned, 0), 0)::numeric
      ),
      0
    )::numeric(14,2) AS product_subtotal
  FROM transaction_lines tl
  LEFT JOIN returned ON returned.transaction_line_id = tl.id
  INNER JOIN products p ON p.id = tl.product_id
  WHERE p.tax_category <> 'service'::tax_category
    AND p.excludes_from_loyalty = FALSE
  GROUP BY tl.transaction_id
)
SELECT
  t.id AS transaction_id,
  t.customer_id AS original_customer_id,
  COALESCE(c.couple_primary_id, t.customer_id) AS effective_customer_id,
  COALESCE(t.fulfilled_at, t.booked_at, t.created_at) AS earned_at,
  eligible_subtotals.product_subtotal,
  (FLOOR(eligible_subtotals.product_subtotal)::int * 5) AS points_earned
FROM transactions t
JOIN checkout_takeaway_status_backfill status_backfill ON status_backfill.id = t.id
JOIN customers c ON c.id = t.customer_id
JOIN eligible_subtotals ON eligible_subtotals.transaction_id = t.id
WHERE t.status = 'fulfilled'::order_status
  AND t.customer_id IS NOT NULL
  AND eligible_subtotals.product_subtotal > 0
  AND (FLOOR(eligible_subtotals.product_subtotal)::int * 5) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM transaction_loyalty_accrual tla
    WHERE tla.transaction_id = t.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM loyalty_point_ledger lpl
    WHERE lpl.transaction_id = t.id
      AND lpl.reason = 'order_earn'
  );

WITH sequenced AS (
  SELECT
    b.*,
    c.loyalty_points AS starting_balance,
    SUM(b.points_earned) OVER (
      PARTITION BY b.effective_customer_id
      ORDER BY b.earned_at, b.transaction_id
    ) AS running_points
  FROM checkout_takeaway_loyalty_backfill b
  JOIN customers c ON c.id = b.effective_customer_id
)
INSERT INTO loyalty_point_ledger (
  customer_id,
  delta_points,
  balance_after,
  reason,
  transaction_id,
  metadata,
  created_at
)
SELECT
  effective_customer_id,
  points_earned,
  starting_balance + running_points,
  'order_earn',
  transaction_id,
  jsonb_build_object(
    'product_subtotal', product_subtotal,
    'original_customer_id', original_customer_id,
    'backfill', 'checkout_takeaway_loyalty'
  ),
  earned_at
FROM sequenced;

WITH totals AS (
  SELECT effective_customer_id, SUM(points_earned)::int AS points_earned
  FROM checkout_takeaway_loyalty_backfill
  GROUP BY effective_customer_id
)
UPDATE customers c
SET loyalty_points = c.loyalty_points + totals.points_earned
FROM totals
WHERE c.id = totals.effective_customer_id;

INSERT INTO transaction_loyalty_accrual (
  transaction_id,
  points_earned,
  product_subtotal,
  created_at
)
SELECT
  transaction_id,
  points_earned,
  product_subtotal,
  earned_at
FROM checkout_takeaway_loyalty_backfill
ON CONFLICT (transaction_id) DO NOTHING;

INSERT INTO transaction_loyalty_accrual (
  transaction_id,
  points_earned,
  product_subtotal,
  created_at
)
SELECT
  lpl.transaction_id,
  lpl.delta_points,
  COALESCE((lpl.metadata->>'product_subtotal')::numeric, 0)::numeric(14,2),
  lpl.created_at
FROM loyalty_point_ledger lpl
WHERE lpl.reason = 'order_earn'
  AND lpl.transaction_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM transaction_loyalty_accrual tla
    WHERE tla.transaction_id = lpl.transaction_id
  )
  AND COALESCE((lpl.metadata->>'product_subtotal')::numeric, 0) > 0
ON CONFLICT (transaction_id) DO NOTHING;

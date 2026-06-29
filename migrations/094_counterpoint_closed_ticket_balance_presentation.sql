-- Counterpoint ticket history represents closed sales, not active ROS work.
-- Some legacy tender offsets span related Counterpoint tickets/open docs, which can
-- leave positive or negative per-ticket display balances if imported literally.
-- Preserve payment provenance rows, but keep closed ticket rows out of open-balance
-- and open-order workflows.
UPDATE transactions
SET status = 'fulfilled'::order_status,
    fulfilled_at = COALESCE(fulfilled_at, booked_at),
    amount_paid = total_price,
    balance_due = 0
WHERE is_counterpoint_import
  AND counterpoint_ticket_ref IS NOT NULL
  AND (
      status IS DISTINCT FROM 'fulfilled'::order_status
      OR COALESCE(balance_due, 0) <> 0
      OR COALESCE(amount_paid, 0) <> COALESCE(total_price, 0)
      OR fulfilled_at IS NULL
  );

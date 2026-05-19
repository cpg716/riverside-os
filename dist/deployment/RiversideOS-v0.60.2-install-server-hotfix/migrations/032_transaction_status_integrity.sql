-- Keep status/reporting integrity visible and repair ROS-created fulfilled lines
-- that predated the fulfilled_at write contract.

UPDATE transaction_lines tl
SET fulfilled_at = COALESCE(tl.fulfilled_at, t.fulfilled_at, t.booked_at, t.created_at)
FROM transactions t
WHERE tl.transaction_id = t.id
  AND tl.is_fulfilled = TRUE
  AND tl.fulfilled_at IS NULL
  AND (t.checkout_client_id IS NOT NULL OR t.register_session_id IS NOT NULL);

DROP VIEW IF EXISTS reporting.transaction_status_integrity;

CREATE VIEW reporting.transaction_status_integrity AS
WITH returned AS (
  SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
  FROM transaction_return_lines
  GROUP BY transaction_line_id
),
line_rollup AS (
  SELECT
    t.id AS transaction_id,
    COALESCE(t.display_id, t.short_id, 'TXN-' || left(t.id::text, 8)) AS transaction_display,
    t.status::text AS transaction_status,
    t.fulfillment_method::text AS fulfillment_method,
    t.booked_at,
    t.fulfilled_at AS transaction_fulfilled_at,
    t.balance_due,
    t.checkout_client_id,
    t.register_session_id,
    t.counterpoint_doc_ref,
    COUNT(tl.id)::bigint AS line_count,
    COUNT(tl.id) FILTER (
      WHERE GREATEST(tl.quantity - COALESCE(returned.returned, 0), 0) > 0
    )::bigint AS active_line_count,
    COUNT(tl.id) FILTER (
      WHERE tl.is_fulfilled = FALSE
        AND GREATEST(tl.quantity - COALESCE(returned.returned, 0), 0) > 0
    )::bigint AS open_active_line_count,
    COUNT(tl.id) FILTER (
      WHERE tl.is_fulfilled = TRUE
        AND tl.fulfilled_at IS NULL
    )::bigint AS fulfilled_line_missing_timestamp_count
  FROM transactions t
  LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id
  LEFT JOIN returned ON returned.transaction_line_id = tl.id
  GROUP BY t.id
)
SELECT
  transaction_id,
  transaction_display,
  transaction_status,
  fulfillment_method,
  booked_at,
  transaction_fulfilled_at,
  balance_due,
  line_count,
  active_line_count,
  open_active_line_count,
  fulfilled_line_missing_timestamp_count,
  CASE
    WHEN transaction_status = 'fulfilled' AND open_active_line_count > 0
      THEN 'fulfilled_transaction_has_open_lines'
    WHEN transaction_status = 'open'
      AND active_line_count > 0
      AND open_active_line_count = 0
      AND balance_due = 0
      THEN 'open_transaction_has_no_open_lines'
    WHEN transaction_status = 'fulfilled' AND transaction_fulfilled_at IS NULL
      THEN 'fulfilled_transaction_missing_timestamp'
    WHEN fulfilled_line_missing_timestamp_count > 0
      THEN 'fulfilled_line_missing_timestamp'
    ELSE 'ok'
  END AS integrity_status,
  CASE
    WHEN checkout_client_id IS NOT NULL OR register_session_id IS NOT NULL THEN 'ros_register'
    WHEN counterpoint_doc_ref IS NOT NULL THEN 'counterpoint_import'
    ELSE 'other'
  END AS source_family
FROM line_rollup;

COMMENT ON VIEW reporting.transaction_status_integrity IS
  'Transaction status consistency monitor for financial trust: transaction status, line fulfillment state, timestamps, and source family.';

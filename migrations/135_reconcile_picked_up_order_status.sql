-- Reconcile legacy rows where lifecycle says picked_up but the fulfillment flag
-- or transaction status was left open. Pickup/revenue reads use both fields.
UPDATE transaction_lines
SET
    is_fulfilled = TRUE,
    fulfilled_at = COALESCE(fulfilled_at, CURRENT_TIMESTAMP)
WHERE order_lifecycle_status = 'picked_up'::order_item_lifecycle_status
  AND fulfillment IN (
      'special_order'::fulfillment_type,
      'custom'::fulfillment_type,
      'wedding_order'::fulfillment_type
  )
  AND is_fulfilled = FALSE;

UPDATE transactions t
SET
    status = 'fulfilled'::order_status,
    fulfilled_at = COALESCE(t.fulfilled_at, CURRENT_TIMESTAMP)
WHERE t.status <> 'cancelled'::order_status
  AND EXISTS (
      SELECT 1
      FROM transaction_lines tl
      WHERE tl.transaction_id = t.id
        AND COALESCE(tl.is_internal, FALSE) = FALSE
        AND tl.fulfillment IN (
            'special_order'::fulfillment_type,
            'custom'::fulfillment_type,
            'wedding_order'::fulfillment_type
        )
  )
  AND NOT EXISTS (
      SELECT 1
      FROM transaction_lines tl
      LEFT JOIN (
          SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
          FROM transaction_return_lines
          GROUP BY transaction_line_id
      ) returned ON returned.transaction_line_id = tl.id
      WHERE tl.transaction_id = t.id
        AND COALESCE(tl.is_internal, FALSE) = FALSE
        AND tl.fulfillment IN (
            'special_order'::fulfillment_type,
            'custom'::fulfillment_type,
            'wedding_order'::fulfillment_type
        )
        AND tl.is_fulfilled = FALSE
        AND GREATEST(tl.quantity - COALESCE(returned.returned, 0), 0) > 0
  );

-- Phase 2.11: commission payout finalization (ledger moves realized → paid)

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS commission_payout_finalized_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS order_items_commission_payout_open_idx
    ON order_items (order_id)
    WHERE is_fulfilled = TRUE
      AND commission_payout_finalized_at IS NULL
      AND calculated_commission > 0;

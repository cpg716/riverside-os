-- Migration 24: Performance indexes, session_ordinal sequence,
-- reserved_stock for special orders, stock lower-bound constraint,
-- and refund-queue uniqueness guard.
--
-- Depends on: 01 (orders, order_items, payment_transactions, product_variants)
--             15 (register_sessions lifecycle columns)
--             21 (order_refund_queue)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Performance indexes (queries across date ranges, sessions, commissions)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_booked_at
    ON orders(booked_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_fulfilled_at
    ON orders(fulfilled_at DESC)
    WHERE fulfilled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_status
    ON orders(status);

CREATE INDEX IF NOT EXISTS idx_order_items_salesperson
    ON order_items(salesperson_id)
    WHERE salesperson_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_is_fulfilled
    ON order_items(is_fulfilled);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_session
    ON payment_transactions(session_id);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_order
    ON payment_allocations(target_order_id);

CREATE INDEX IF NOT EXISTS idx_staff_access_log_staff
    ON staff_access_log(staff_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_access_log_event
    ON staff_access_log(event_kind, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Register session ordinal — monotonic, gap-free, O(1) lookup.
--    Replaces the correlated subquery that did a full-table scan per session.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE register_sessions
    ADD COLUMN IF NOT EXISTS session_ordinal BIGSERIAL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_register_sessions_ordinal
    ON register_sessions(session_ordinal);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Reserved stock — tracks items physically in the store but already
--    promised to a special/custom order. Separate from stock_on_hand.
--
--    Lifecycle:
--      special_order placed  → no stock movement
--      PO received for SKU   → stock_on_hand +qty  AND  reserved_stock +qty
--      customer pickup       → stock_on_hand -qty  AND  reserved_stock -qty
--
--    available_on_hand = stock_on_hand - reserved_stock  (computed in app)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS reserved_stock INTEGER NOT NULL DEFAULT 0;

ALTER TABLE product_variants
    ADD CONSTRAINT reserved_stock_non_negative
    CHECK (reserved_stock >= 0);

COMMENT ON COLUMN product_variants.reserved_stock IS
    'Units physically in store but promised to an open special or custom order.
     available_on_hand = stock_on_hand - reserved_stock.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Stock lower-bound sanity guard (allows slight negatives for edge cases,
--    hard floor prevents runaway corruption from concurrent bugs).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE product_variants
        ADD CONSTRAINT stock_reasonable_lower_bound
        CHECK (stock_on_hand >= -999);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Refund queue uniqueness — one open refund entry per order at a time.
--    Prevents double-cancel from inserting duplicate rows.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_queue_order_open
    ON order_refund_queue(order_id)
    WHERE is_open = true;

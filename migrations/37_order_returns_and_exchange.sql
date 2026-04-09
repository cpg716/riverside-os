-- Line-level returns (audit + restock flag) and optional exchange grouping between orders.

CREATE TABLE IF NOT EXISTS order_return_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    quantity_returned INTEGER NOT NULL CHECK (quantity_returned > 0),
    reason TEXT,
    restocked BOOLEAN NOT NULL DEFAULT false,
    staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_return_lines_order
    ON order_return_lines(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_return_lines_item
    ON order_return_lines(order_item_id);

COMMENT ON TABLE order_return_lines IS 'Append-only return events; effective line qty = order_items.quantity minus SUM(quantity_returned) per item.';

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS exchange_group_id UUID;

COMMENT ON COLUMN orders.exchange_group_id IS 'Links paired orders for an exchange (same UUID on both legs).';

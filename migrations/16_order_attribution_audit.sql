-- Immutable audit trail for post-sale salesperson corrections (commission integrity).

CREATE TABLE IF NOT EXISTS order_attribution_audit (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id UUID REFERENCES order_items(id) ON DELETE SET NULL,
    prior_salesperson_id UUID REFERENCES staff(id),
    new_salesperson_id UUID REFERENCES staff(id),
    corrected_by_staff_id UUID NOT NULL REFERENCES staff(id),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_attr_audit_order
    ON order_attribution_audit (order_id);

COMMENT ON TABLE order_attribution_audit IS 'Append-only log when manager corrects order_items.salesperson_id after checkout.';

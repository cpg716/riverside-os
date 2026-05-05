-- Suit component swap audit (per-order line replacement + inventory); register.open_drawer for drawer adjustments from BO.

CREATE TABLE suit_component_swap_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff(id),
    old_variant_id UUID NOT NULL REFERENCES product_variants(id),
    new_variant_id UUID NOT NULL REFERENCES product_variants(id),
    old_product_id UUID NOT NULL REFERENCES products(id),
    new_product_id UUID NOT NULL REFERENCES products(id),
    effective_quantity INTEGER NOT NULL CHECK (effective_quantity > 0),
    old_unit_cost NUMERIC(12, 2) NOT NULL,
    new_unit_cost NUMERIC(12, 2) NOT NULL,
    old_unit_price NUMERIC(12, 2) NOT NULL,
    new_unit_price NUMERIC(12, 2) NOT NULL,
    inventory_adjusted BOOLEAN NOT NULL DEFAULT FALSE,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_suit_component_swap_events_order ON suit_component_swap_events (order_id);
CREATE INDEX idx_suit_component_swap_events_created ON suit_component_swap_events ((created_at AT TIME ZONE 'UTC'));

COMMENT ON TABLE suit_component_swap_events IS 'Audited in/out variant replacements on an order line (3pc suit swaps); see logic/suit_component_swap.rs';

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'orders.suit_component_swap', true),
    ('sales_support', 'orders.suit_component_swap', true),
    ('salesperson', 'orders.suit_component_swap', true),
    ('admin', 'register.open_drawer', true),
    ('sales_support', 'register.open_drawer', true),
    ('salesperson', 'register.open_drawer', true)
ON CONFLICT (role, permission_key) DO NOTHING;

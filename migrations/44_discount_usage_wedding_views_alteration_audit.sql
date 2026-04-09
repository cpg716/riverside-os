-- Checkout discount event analytics, optional wedding insights presets, alteration audit trail.

CREATE TABLE IF NOT EXISTS discount_event_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES discount_events(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    line_subtotal NUMERIC(14, 2) NOT NULL,
    discount_percent NUMERIC(5, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discount_event_usage_event
    ON discount_event_usage (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discount_event_usage_order
    ON discount_event_usage (order_id);

COMMENT ON TABLE discount_event_usage IS 'One row per order line that applied a scheduled discount event at checkout.';

CREATE TABLE IF NOT EXISTS wedding_insight_saved_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (staff_id, name)
);

CREATE TABLE IF NOT EXISTS alteration_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alteration_id UUID NOT NULL REFERENCES alteration_orders(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alteration_activity_alt
    ON alteration_activity (alteration_id, created_at DESC);

-- Migration 111: Layaway and On-Hold Tracking

-- 1. Add 'layaway' to line item fulfillment types
ALTER TYPE fulfillment_type ADD VALUE 'layaway';

-- 2. Track inventory currently on hold for layaways
ALTER TABLE product_variants ADD COLUMN on_layaway INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_variants ADD CONSTRAINT on_layaway_non_negative CHECK (on_layaway >= 0);

-- 3. Tracking for forfeited deposits
ALTER TABLE orders ADD COLUMN is_forfeited BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN forfeited_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE orders ADD COLUMN forfeiture_reason TEXT;

-- 4. Audit log for layaway events
CREATE TABLE layaway_activity_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff(id),
    action TEXT NOT NULL, -- 'created', 'payment', 'forfeited', 'cancelled', 'picked_up'
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_layaway_activity_order_id ON layaway_activity_log(order_id);

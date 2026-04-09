-- Counterpoint Historical Finishing: Ticket Notes, Line Reason Codes, and Receiving History (migration 114).
-- Enables Jan 2021 - Present reporting and customer service parity.

-- 1) Standard notes on orders (if missing from core)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;

-- 2) Reason codes on items (Returns, Voids, Discounts)
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS counterpoint_reason_code TEXT;

-- 3) Historical Vendor Costing / Receiving History
-- This table stores raw PO_RECVR_HIST data for gross margin analytics across the 2021-2026 period.
CREATE TABLE IF NOT EXISTS counterpoint_receiving_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vend_no TEXT NOT NULL,
    item_no TEXT NOT NULL,
    recv_dat TIMESTAMPTZ NOT NULL,
    unit_cost NUMERIC(14, 4) NOT NULL,
    qty_recv NUMERIC(14, 4) NOT NULL,
    po_no TEXT,
    recv_no TEXT,
    variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS counterpoint_receiving_history_item_idx ON counterpoint_receiving_history (item_no);
CREATE INDEX IF NOT EXISTS counterpoint_receiving_history_date_idx ON counterpoint_receiving_history (recv_dat DESC);

-- 4) Sync run tracking for the new entity
INSERT INTO ros_schema_migrations (version) VALUES ('114_counterpoint_historical_finishing.sql') ON CONFLICT (version) DO NOTHING;

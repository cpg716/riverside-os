-- Phase 2.10: weighted procurement — vendor polish, brand portfolio, direct invoices, WAC metadata

ALTER TABLE vendors
    ADD COLUMN IF NOT EXISTS account_number TEXT,
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS vendor_brands (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    brand TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS vendor_brands_vendor_lower_idx
    ON vendor_brands (vendor_id, lower(brand));

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS primary_vendor_id UUID REFERENCES vendors(id);

ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS po_kind TEXT NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fully_received_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS split_from_po_id UUID REFERENCES purchase_orders(id);

ALTER TABLE purchase_orders
    DROP CONSTRAINT IF EXISTS purchase_orders_po_kind_check;

ALTER TABLE purchase_orders
    ADD CONSTRAINT purchase_orders_po_kind_check
        CHECK (po_kind IN ('standard', 'direct_invoice'));

UPDATE purchase_orders SET po_kind = 'standard' WHERE po_kind IS NULL;

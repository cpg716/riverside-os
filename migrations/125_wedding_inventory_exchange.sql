-- Migration 125: Wedding Inventory Exchange and Non-Inventory Tracking

-- 1. Add suit_variant_id to wedding_parties (Template)
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS suit_variant_id UUID REFERENCES product_variants(id);

-- 2. Add suit_variant_id to wedding_members (Individual selection)
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS suit_variant_id UUID REFERENCES product_variants(id);

-- 3. Create table for non-inventory items needed for orders
CREATE TABLE IF NOT EXISTS wedding_non_inventory_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wedding_party_id UUID NOT NULL REFERENCES wedding_parties(id) ON DELETE CASCADE,
    wedding_member_id UUID REFERENCES wedding_members(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'needed', -- 'needed', 'ordered', 'received'
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Index for performance
CREATE INDEX IF NOT EXISTS idx_wedding_members_suit_variant ON wedding_members(suit_variant_id);
CREATE INDEX IF NOT EXISTS idx_wedding_non_inv_party ON wedding_non_inventory_items(wedding_party_id);

-- 5. Add a trigger to update updated_at
DROP TRIGGER IF EXISTS update_wedding_non_inventory_items_modtime ON wedding_non_inventory_items;
CREATE TRIGGER update_wedding_non_inventory_items_modtime
BEFORE UPDATE ON wedding_non_inventory_items
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

-- NuORDER Integration Hardening: Vendor Mapping, Image Refresh, and Enhanced Logging
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS nuorder_id TEXT; -- Per-variant NuORDER ID
ALTER TABLE products ADD COLUMN IF NOT EXISTS nuorder_last_image_sync_at TIMESTAMPTZ;

-- Enhanced sync logs with more granularity
ALTER TABLE nuorder_sync_logs ADD COLUMN IF NOT EXISTS created_count INTEGER DEFAULT 0;
ALTER TABLE nuorder_sync_logs ADD COLUMN IF NOT EXISTS updated_count INTEGER DEFAULT 0;
ALTER TABLE nuorder_sync_logs ADD COLUMN IF NOT EXISTS skipped_count INTEGER DEFAULT 0;

-- Audit trail for mapping changes
CREATE TABLE IF NOT EXISTS nuorder_entity_map_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type TEXT NOT NULL, -- 'vendor', 'product', 'variant'
    ros_entity_id UUID NOT NULL,
    nuorder_entity_id TEXT NOT NULL,
    mapped_by UUID REFERENCES staff(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Index for SKU/UPC matching performance
CREATE INDEX IF NOT EXISTS idx_product_variants_nuorder_id ON product_variants(nuorder_id);

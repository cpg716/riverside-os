-- Migration 148: Store Mapping (Visual Zones) and Collaborative Inventory Counts
-- Depends on: 01, 26

-- ─────────────────────────────────────────────────────────────────
-- Part A: Store Map Architecture
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inventory_map_layouts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    -- JSON/SVG representation of the store floorplan
    layout_data JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    layout_id UUID REFERENCES inventory_map_layouts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- zone_type: 'sales_floor', 'backroom', 'display', 'receiving'
    zone_type TEXT NOT NULL DEFAULT 'sales_floor',
    -- SVG coordinates/geometry for the zone
    geometry JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Index for lookup by layout
CREATE INDEX IF NOT EXISTS idx_inv_loc_layout ON inventory_locations(layout_id);

-- Attach a default location to variants for "Home" shelf tracking
ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS default_location_id UUID REFERENCES inventory_locations(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────
-- Part B: Collaborative Count Streams
-- ─────────────────────────────────────────────────────────────────

-- Granular scan log for real-time collaboration dashboards
-- This and physical_inventory_audit together provide full traceability.
CREATE TABLE IF NOT EXISTS inventory_count_scan_stream (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES physical_inventory_sessions(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id),
    variant_id UUID NOT NULL REFERENCES product_variants(id),
    location_id UUID REFERENCES inventory_locations(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- device_id: for tracking which iPad/Handheld performed the scan
    device_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_inv_count_stream_session ON inventory_count_scan_stream(session_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_count_stream_staff ON inventory_count_scan_stream(staff_id);

-- ─────────────────────────────────────────────────────────────────
-- Part C: Category Tax Rules (Inheritance expansion)
-- ─────────────────────────────────────────────────────────────────

-- Adding structured tax rule overrides to categories
ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS tax_rules JSONB DEFAULT NULL;

COMMENT ON TABLE inventory_map_layouts IS 'Defines the visual floorplan (SVG/JSON) for the store.';
COMMENT ON TABLE inventory_locations IS 'Specific zones defined on the floorplan for product mapping.';
COMMENT ON TABLE inventory_count_scan_stream IS 'Raw real-time scan events for collaborative counting sessions.';

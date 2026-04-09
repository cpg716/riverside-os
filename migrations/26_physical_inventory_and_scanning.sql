-- Migration 26: Physical Inventory System & Unified Scanning Support
-- Depends on: 01 (product_variants, vendors, orders, order_items, staff)

-- ─────────────────────────────────────────────────────────────────
-- Part A: Vendor UPC scanning support
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS vendor_upc TEXT;

CREATE INDEX IF NOT EXISTS idx_pv_vendor_upc_lower
    ON product_variants (lower(vendor_upc))
    WHERE vendor_upc IS NOT NULL AND vendor_upc <> '';

-- Flag: when true, receiving scans check vendor_upc before barcode/sku
ALTER TABLE vendors
    ADD COLUMN IF NOT EXISTS use_vendor_upc BOOLEAN NOT NULL DEFAULT FALSE;

-- ─────────────────────────────────────────────────────────────────
-- Part B: Physical Inventory Sessions
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE physical_inventory_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Human-readable identifier shown in history list
    session_number  TEXT UNIQUE NOT NULL,
    -- open = actively counting, reviewing = locked for review/publish,
    -- published = immutable archive, cancelled = abandoned
    status          TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','reviewing','published','cancelled')),
    -- full = all active products, category = scoped by category_ids
    scope           TEXT NOT NULL DEFAULT 'full'
                        CHECK (scope IN ('full','category')),
    -- Array of category UUIDs when scope = 'category'
    category_ids    UUID[] NOT NULL DEFAULT '{}',
    started_by      UUID REFERENCES staff(id),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_saved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at    TIMESTAMPTZ,
    published_by    UUID REFERENCES staff(id),
    notes           TEXT
);

-- Enforce single active session at the application layer;
-- this index ensures at most one session per status in {open, reviewing}.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_inventory_session
    ON physical_inventory_sessions (status)
    WHERE status IN ('open', 'reviewing');

-- ─────────────────────────────────────────────────────────────────
-- Part C: Stock Snapshot (taken at session creation)
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE physical_inventory_snapshots (
    session_id      UUID NOT NULL REFERENCES physical_inventory_sessions(id) ON DELETE CASCADE,
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    -- stock_on_hand captured the moment the session was started
    stock_at_start  INTEGER NOT NULL,
    PRIMARY KEY (session_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_pi_snapshots_session
    ON physical_inventory_snapshots (session_id);

-- ─────────────────────────────────────────────────────────────────
-- Part D: Counted Items During Session
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE physical_inventory_counts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID NOT NULL REFERENCES physical_inventory_sessions(id) ON DELETE CASCADE,
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    -- Physical count by staff; scans accumulate here (counted_qty increments per scan)
    counted_qty     INTEGER NOT NULL DEFAULT 0,
    last_scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scan_source     TEXT NOT NULL DEFAULT 'laser'
                        CHECK (scan_source IN ('laser','camera','manual')),
    counted_by      UUID REFERENCES staff(id),
    -- Review phase fields
    review_status   TEXT NOT NULL DEFAULT 'pending'
                        CHECK (review_status IN ('pending','ok','adjusted')),
    -- Staff override during review (NULL = use counted_qty)
    adjusted_qty    INTEGER CHECK (adjusted_qty >= 0),
    review_note     TEXT,
    -- one count row per (session, variant)
    UNIQUE (session_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_pi_counts_session
    ON physical_inventory_counts (session_id);
CREATE INDEX IF NOT EXISTS idx_pi_counts_variant
    ON physical_inventory_counts (variant_id);

-- ─────────────────────────────────────────────────────────────────
-- Part E: Audit Log
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE physical_inventory_audit (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID NOT NULL REFERENCES physical_inventory_sessions(id) ON DELETE CASCADE,
    variant_id      UUID REFERENCES product_variants(id),
    -- scan | manual_entry | review_adjust | found_item |
    -- session_open | session_close | session_move_review | publish | cancel
    event_type      TEXT NOT NULL,
    old_qty         INTEGER,
    new_qty         INTEGER,
    note            TEXT,
    performed_by    UUID REFERENCES staff(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pi_audit_session
    ON physical_inventory_audit (session_id, created_at DESC);

COMMENT ON TABLE physical_inventory_sessions IS
    'Physical inventory counting sessions. Only one open/reviewing session may exist at a time.';
COMMENT ON TABLE physical_inventory_counts IS
    'Running count log per (session, variant). Scans increment counted_qty. adjusted_qty overrides at publish.';
COMMENT ON TABLE physical_inventory_audit IS
    'Full event audit trail for every scan, adjustment, and lifecycle event within a session.';
COMMENT ON COLUMN physical_inventory_counts.adjusted_qty IS
    'Staff override set during the Review phase. NULL means counted_qty is used at publish.';

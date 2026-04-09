-- NuORDER Integration: Catalog, Orders, and Inventory Sync State
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS nuorder_brand_id TEXT;

CREATE TABLE IF NOT EXISTS nuorder_sync_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_catalog_sync_at TIMESTAMPTZ,
    last_order_sync_at TIMESTAMPTZ,
    last_inventory_sync_at TIMESTAMPTZ,
    CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO nuorder_sync_state (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS nuorder_sync_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sync_type TEXT NOT NULL, -- 'catalog', 'orders', 'inventory'
    status TEXT NOT NULL,    -- 'success', 'failure', 'partial'
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMPTZ,
    result_count INTEGER DEFAULT 0,
    error_message TEXT,
    payload JSONB -- Useful for debugging small error samples
);

-- Store NuORDER credentials securely (conceptually, env vars are preferred but let's add a config shell)
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS nuorder_config JSONB DEFAULT '{}'::jsonb;

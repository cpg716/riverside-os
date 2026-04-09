-- Add exclusion filters for physical inventory sessions
ALTER TABLE physical_inventory_sessions
ADD COLUMN IF NOT EXISTS exclude_reserved BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS exclude_layaway BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN physical_inventory_sessions.exclude_reserved IS 'If true, inventory counts on floor should match (stock_on_hand - reserved_stock).';
COMMENT ON COLUMN physical_inventory_sessions.exclude_layaway IS 'If true, inventory counts on floor should match (stock_on_hand - on_layaway).';

INSERT INTO ros_schema_migrations (version) VALUES ('113_physical_inventory_exclusions.sql')
ON CONFLICT (version) DO NOTHING;
